import { describe, expect, it, vi } from 'vitest';

import {
  ContentKind,
  createContentRevision,
  createPlatformVariant,
  type AccountConnection,
} from '../domain/index.js';
import { PublishingService } from './publishing-service.js';

describe('PublishingService', () => {
  it('derives platform and delivery mode from persisted accounts', () => {
    const publication = publicationFixture();
    const service = new PublishingService(
      { getRevision: vi.fn(() => revisionFixture()) },
      { list: vi.fn(() => [accountFixture()]) },
      publication,
      () => new Date('2026-10-12T08:00:00.000Z'),
    );

    service.createPlan({
      revisionId: 'revision-1',
      accountIds: ['account-1'],
      scheduledAt: null,
      platformFieldsByAccount: {
        'account-1': {
          uploadUri: 'file:///content/video.mp4',
          privacyStatus: 'private',
          __omniPostAccountBindingVersion: 999,
          __omniPostContentHash: 'f'.repeat(64),
        },
      },
    });

    expect(publication.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      revision: expect.objectContaining({ id: 'revision-1' }),
      variants: [expect.objectContaining({ id: 'variant-youtube', platform: 'YOUTUBE' })],
      targets: [{
        accountId: 'account-1',
        platform: 'YOUTUBE',
        deliveryMode: 'DIRECT_API',
        scheduledAt: null,
        platformFields: {
          __omniPostAccountBindingVersion: 1,
          __omniPostContentHash: expect.not.stringContaining('f'.repeat(64)),
          bodyHtml: '<p>平台简介</p>',
          bodyMarkdown: '平台简介',
          privacyStatus: 'private',
          tags: ['OmniPost'],
          title: 'YouTube 标题',
          uploadUri: 'file:///content/video.mp4',
        },
      }],
    }));
  });

  it('downgrades a requested direct connection when capability probes are not available', () => {
    const publication = publicationFixture();
    const account = accountFixture();
    const service = new PublishingService(
      { getRevision: vi.fn(() => revisionFixture()) },
      { list: vi.fn(() => [{
        ...account,
        capabilityContext: {
          qualifications: [],
          scopes: [],
          probes: {
            directApi: 'UNKNOWN' as const,
            remoteDraft: 'UNKNOWN' as const,
            assistedBrowser: 'AVAILABLE' as const,
          },
        },
      }]) },
      publication,
    );

    service.createPlan({
      revisionId: 'revision-1', accountIds: ['account-1'], scheduledAt: null,
      platformFieldsByAccount: {},
    });

    expect(publication.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ deliveryMode: 'MANUAL_HANDOFF' })],
    }));
  });

  it('rejects missing accounts and past schedules', () => {
    const service = new PublishingService(
      { getRevision: vi.fn(() => revisionFixture()) },
      { list: vi.fn(() => [accountFixture()]) },
      publicationFixture(),
      () => new Date('2026-10-12T08:00:00.000Z'),
    );

    expect(() => service.createPlan({
      revisionId: 'revision-1', accountIds: ['forged-account'], scheduledAt: null,
    })).toThrow('账号不存在');
    expect(() => service.createPlan({
      revisionId: 'revision-1',
      accountIds: ['account-1'],
      scheduledAt: '2026-10-12T07:59:59.000Z',
    })).toThrow('未来时间');
  });

  it('requires a separate explicit approval action', () => {
    const publication = publicationFixture();
    const service = new PublishingService(
      { getRevision: vi.fn(() => revisionFixture()) },
      { list: vi.fn(() => [accountFixture()]) },
      publication,
    );

    service.approve('plan-1');

    expect(publication.approve).toHaveBeenCalledWith('plan-1', 'local-user');
  });
});

function revisionFixture() {
  return createContentRevision({
    id: 'revision-1',
    contentItemId: 'item-1',
    revisionNumber: 1,
    kind: ContentKind.VIDEO,
    title: '视频',
    bodyMarkdown: '简介',
    media: [],
    sourceHash: null,
    createdAt: '2026-10-12T00:00:00.000Z',
  });
}

function accountFixture(): AccountConnection & {
  bindingVersion: number;
  credentialNames: string[];
  capabilityContext: {
    qualifications: string[];
    scopes: string[];
    probes: {
      directApi: 'AVAILABLE';
      remoteDraft: 'UNAVAILABLE';
      assistedBrowser: 'AVAILABLE';
    };
  };
} {
  return {
    id: 'account-1',
    platform: 'YOUTUBE',
    externalAccountId: null,
    displayName: '频道',
    deliveryMode: 'DIRECT_API',
    credentialRef: null,
    enabled: true,
    capabilitiesCheckedAt: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    bindingVersion: 1,
    credentialNames: [],
    capabilityContext: {
      qualifications: [],
      scopes: ['youtube.upload'],
      probes: {
        directApi: 'AVAILABLE',
        remoteDraft: 'UNAVAILABLE',
        assistedBrowser: 'AVAILABLE',
      },
    },
  };
}

function publicationFixture() {
  const revision = revisionFixture();
  const variant = createPlatformVariant({
    id: 'variant-youtube',
    revisionId: revision.id,
    platform: 'YOUTUBE',
    title: 'YouTube 标题',
    bodyMarkdown: '平台简介',
    media: null,
    platformFields: { tags: ['OmniPost'] },
    createdAt: '2026-10-12T01:00:00.000Z',
  });
  return {
    createPlan: vi.fn(() => ({
      plan: {
        id: 'plan-1',
        revisionId: revision.id,
        variantIds: [variant.id],
        targets: [],
        contentHash: revision.contentHash,
      },
      jobs: [],
    })),
    approve: vi.fn(() => ({
      plan: {
        id: 'plan-1',
        revisionId: revision.id,
        variantIds: [variant.id],
        targets: [],
        contentHash: revision.contentHash,
      },
      jobs: [],
    })),
    listJobs: vi.fn(() => []),
    listVariants: vi.fn(() => [variant]),
  };
}
