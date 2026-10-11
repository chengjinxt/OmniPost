import { describe, expect, it } from 'vitest';

import {
  ContentKind,
  DeliveryMode,
  createPublishIdempotencyKey,
  type ContentRevision,
  type PublishTarget,
} from '../../domain/index.js';
import { buildPreparedPublication } from './adapter-runtime.js';

const NOW = '2026-10-12T05:00:00.000Z';
const REVISION_HASH = 'a'.repeat(64);
const VARIANT_HASH = 'b'.repeat(64);

function revision(id: string): ContentRevision {
  return {
    id,
    contentItemId: 'content-1',
    revisionNumber: 1,
    kind: ContentKind.ARTICLE,
    title: 'Title',
    bodyMarkdown: 'Body',
    media: [],
    sourceHash: null,
    contentHash: REVISION_HASH,
    createdAt: NOW,
  };
}

describe('buildPreparedPublication', () => {
  it('uses the selected platform variant hash and the shared semantic key algorithm', () => {
    const target: PublishTarget = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: '2026-10-13T05:00:00.000Z',
      platformFields: {
        __omniPostContentHash: VARIANT_HASH,
        bodyHtml: '<p>Platform variant</p>',
      },
    };

    const prepared = buildPreparedPublication(revision('revision-random-1'), target, NOW);

    expect(prepared.contentHash).toBe(VARIANT_HASH);
    expect(prepared.idempotencyKey).toBe(
      createPublishIdempotencyKey({
        accountId: target.accountId,
        platform: target.platform,
        deliveryMode: target.deliveryMode,
        contentHash: VARIANT_HASH,
        scheduledAt: target.scheduledAt,
        platformFields: target.platformFields,
      }),
    );
    expect(
      buildPreparedPublication(revision('revision-random-2'), target, NOW).idempotencyKey,
    ).toBe(prepared.idempotencyKey);
  });

  it('falls back to the revision hash for targets created before variant hash binding', () => {
    const target: PublishTarget = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.REMOTE_DRAFT,
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>Legacy target</p>' },
    };

    expect(buildPreparedPublication(revision('revision-legacy'), target, NOW).contentHash).toBe(
      REVISION_HASH,
    );
  });
});
