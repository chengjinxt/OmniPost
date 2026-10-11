import { describe, expect, it } from 'vitest';

import {
  AccountCapabilitiesSchema,
  ContentKind,
  DeliveryMode,
  ImportCandidateSchema,
  ImportPreviewSchema,
  PreparedPublicationSchema,
  RemotePublicationStatusSchema,
  SubmissionReceiptSchema,
} from './index.js';

const NOW = '2026-10-12T02:00:00.000Z';
const HASH = 'a'.repeat(64);

describe('port data contracts', () => {
  it('validates importer discovery and preview values', () => {
    const candidate = {
      id: 'candidate-1',
      importer: 'knowcraft',
      sourceRoot: 'C:\\content',
      sourcePath: 'C:\\content\\topic',
      relativePath: 'topic',
      titleHint: 'Topic',
      kind: ContentKind.IMAGE_POST,
      sourceHash: HASH,
      metadata: { readOnly: true },
    };

    expect(ImportCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      ImportPreviewSchema.safeParse({
        candidate,
        title: 'Topic',
        bodyMarkdown: '',
        frontmatter: {},
        media: [
          {
            sourcePath: 'C:\\content\\topic\\01-card.png',
            originalName: '01-card.png',
            kind: ContentKind.IMAGE_POST,
            order: 0,
            sha256: HASH,
          },
        ],
        warnings: [],
      }).success,
    ).toBe(true);
  });

  it('represents probed delivery capabilities without treating unsupported as API support', () => {
    const capabilities = AccountCapabilitiesSchema.parse({
      accountId: 'account-1',
      platform: 'wechat',
      deliveryModes: [DeliveryMode.REMOTE_DRAFT, DeliveryMode.ASSISTED_BROWSER],
      contentKinds: [ContentKind.ARTICLE, ContentKind.IMAGE_POST],
      features: {
        supportsDrafts: true,
        supportsScheduling: false,
        supportsRemoteStatus: false,
      },
      qualifications: [
        { code: 'verified', label: 'Verified account', status: 'SATISFIED', details: null },
      ],
      scopes: [{ name: 'draft.write', granted: true }],
      probes: [{ code: 'draft-api', status: 'PASS', message: null }],
      checkedAt: NOW,
    });

    expect(capabilities.deliveryModes).not.toContain(DeliveryMode.DIRECT_API);
    expect(capabilities.features.supportsDrafts).toBe(true);
  });

  it('binds a prepared publication to content and idempotency hashes', () => {
    const result = PreparedPublicationSchema.safeParse({
      id: 'prepared-1',
      revisionId: 'revision-1',
      target: {
        accountId: 'account-1',
        platform: 'wechat',
        deliveryMode: DeliveryMode.REMOTE_DRAFT,
        scheduledAt: null,
        platformFields: {},
      },
      contentHash: HASH,
      idempotencyKey: `publish_${HASH}`,
      createdAt: NOW,
    });

    expect(result.success).toBe(true);
  });

  it('persists the account context and status metadata required to poll after restart', () => {
    const receipt = SubmissionReceiptSchema.parse({
      id: 'receipt-1',
      preparedId: 'prepared-1',
      platform: 'wechat',
      accountId: 'account-1',
      deliveryMode: DeliveryMode.DIRECT_API,
      idempotencyKey: `publish_${HASH}`,
      remoteId: 'remote-1',
      status: {
        state: 'PROCESSING',
        url: null,
        message: 'Remote processing',
      },
      submittedAt: NOW,
    });

    expect(receipt.accountId).toBe('account-1');
    expect(receipt.status?.state).toBe('PROCESSING');
  });

  it('rejects local workflow states as remote publication status', () => {
    expect(
      RemotePublicationStatusSchema.safeParse({
        state: 'AWAITING_APPROVAL',
        remoteId: null,
        url: null,
        message: null,
        checkedAt: NOW,
      }).success,
    ).toBe(false);
  });
});
