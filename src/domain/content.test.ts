import { describe, expect, it } from 'vitest';

import {
  AccountConnectionSchema,
  ContentItemSchema,
  ContentKind,
  ContentKindSchema,
  DeliveryMode,
  DeliveryModeSchema,
  JobState,
  JobStateSchema,
  MediaAssetSchema,
  PlatformVariantSchema,
  PublishAttemptSchema,
  PublishJobSchema,
  PublishPlanSchema,
  RunArtifactSchema,
  approvePublishPlan,
  createContentRevision,
  createNextContentRevision,
  createPlatformVariant,
  createPublishIdempotencyKey,
  createPublishPlan,
  isPublishPlanApprovalValid,
  refreshPublishPlanContent,
} from './index.js';

const CREATED_AT = '2026-10-12T01:00:00.000Z';
const UPDATED_AT = '2026-10-12T01:05:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('domain enums', () => {
  it('accepts exactly the product contract values', () => {
    expect(Object.values(ContentKind)).toEqual(['ARTICLE', 'IMAGE_POST', 'VIDEO']);
    expect(Object.values(DeliveryMode)).toEqual([
      'DIRECT_API',
      'REMOTE_DRAFT',
      'ASSISTED_BROWSER',
      'MANUAL_HANDOFF',
      'UNSUPPORTED',
    ]);
    expect(Object.values(JobState)).toEqual([
      'DRAFT',
      'AWAITING_APPROVAL',
      'APPROVED',
      'SCHEDULED',
      'PREPARING',
      'SUBMITTED',
      'PROCESSING',
      'PUBLISHED',
      'REJECTED',
      'NEEDS_ACTION',
      'FAILED',
      'UNKNOWN',
      'CANCELLED',
    ]);

    expect(ContentKindSchema.safeParse('POST').success).toBe(false);
    expect(DeliveryModeSchema.safeParse('PUBLISH_NOW').success).toBe(false);
    expect(JobStateSchema.safeParse('DONE').success).toBe(false);
  });
});

describe('ContentRevision', () => {
  it('creates a recursively immutable revision with a canonical content hash', () => {
    const revision = createContentRevision({
      id: 'revision-1',
      contentItemId: 'content-1',
      revisionNumber: 1,
      kind: ContentKind.ARTICLE,
      title: 'A',
      bodyMarkdown: 'Hello',
      media: [],
      sourceHash: null,
      createdAt: CREATED_AT,
    });

    expect(revision.contentHash).toBe(
      '15d551c39f077a735c9fe5d27b95252a21dc4b81a4300c77cdb019c7e1f26aa1',
    );
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.media)).toBe(true);
    expect(() => (revision.media as unknown as unknown[]).push('changed')).toThrow(TypeError);
  });

  it('creates a new revision instead of mutating the previous revision', () => {
    const original = createContentRevision({
      id: 'revision-1',
      contentItemId: 'content-1',
      revisionNumber: 1,
      kind: ContentKind.ARTICLE,
      title: 'Original',
      bodyMarkdown: 'Version one',
      media: [],
      sourceHash: null,
      createdAt: CREATED_AT,
    });

    const next = createNextContentRevision(original, {
      id: 'revision-2',
      bodyMarkdown: 'Version two',
      createdAt: UPDATED_AT,
    });

    expect(next).not.toBe(original);
    expect(next.revisionNumber).toBe(2);
    expect(next.bodyMarkdown).toBe('Version two');
    expect(original.bodyMarkdown).toBe('Version one');
    expect(next.contentHash).not.toBe(original.contentHash);
  });
});

describe('approval binding', () => {
  const createFixture = () => {
    const revision = createContentRevision({
      id: 'revision-1',
      contentItemId: 'content-1',
      revisionNumber: 1,
      kind: ContentKind.ARTICLE,
      title: 'Canonical title',
      bodyMarkdown: 'Canonical body',
      media: [{ assetId: 'asset-1', sha256: HASH_A, order: 0 }],
      sourceHash: null,
      createdAt: CREATED_AT,
    });
    const variant = createPlatformVariant({
      id: 'variant-1',
      revisionId: revision.id,
      platform: 'wechat',
      title: null,
      bodyMarkdown: null,
      media: null,
      platformFields: { digest: 'Short digest', original: true },
      createdAt: CREATED_AT,
    });
    const plan = createPublishPlan({
      id: 'plan-1',
      revision,
      variants: [variant],
      targets: [
        {
          accountId: 'account-1',
          platform: 'wechat',
          deliveryMode: DeliveryMode.REMOTE_DRAFT,
          scheduledAt: null,
          platformFields: {},
        },
      ],
      createdAt: CREATED_AT,
    });
    const approved = approvePublishPlan(plan, {
      approvedBy: 'user-1',
      approvedAt: UPDATED_AT,
    });

    return { approved, revision, variant };
  };

  it.each([
    [
      '正文',
      (revision: ReturnType<typeof createContentRevision>) =>
        createNextContentRevision(revision, {
          id: 'revision-body',
          bodyMarkdown: 'Changed body',
          createdAt: UPDATED_AT,
        }),
    ],
    [
      '媒体',
      (revision: ReturnType<typeof createContentRevision>) =>
        createNextContentRevision(revision, {
          id: 'revision-media',
          media: [{ assetId: 'asset-2', sha256: HASH_B, order: 0 }],
          createdAt: UPDATED_AT,
        }),
    ],
  ])('%s变化后清除已有批准', (_name, revise) => {
    const { approved, revision, variant } = createFixture();
    const nextRevision = revise(revision);
    const nextVariant = createPlatformVariant({
      id: `variant-${nextRevision.id}`,
      revisionId: nextRevision.id,
      platform: variant.platform,
      title: variant.title,
      bodyMarkdown: variant.bodyMarkdown,
      media: null,
      platformFields: { digest: 'Short digest', original: true },
      createdAt: UPDATED_AT,
    });

    const refreshed = refreshPublishPlanContent(
      approved,
      nextRevision,
      [nextVariant],
      UPDATED_AT,
    );

    expect(refreshed.approval).toBeNull();
    expect(isPublishPlanApprovalValid(refreshed)).toBe(false);
  });

  it('平台字段变化后清除已有批准', () => {
    const { approved, revision, variant } = createFixture();
    const changedVariant = createPlatformVariant({
      id: 'variant-2',
      revisionId: revision.id,
      platform: variant.platform,
      title: variant.title,
      bodyMarkdown: variant.bodyMarkdown,
      media: null,
      platformFields: { digest: 'Changed digest', original: true },
      createdAt: UPDATED_AT,
    });

    const refreshed = refreshPublishPlanContent(
      approved,
      revision,
      [changedVariant],
      UPDATED_AT,
    );

    expect(refreshed.approval).toBeNull();
    expect(isPublishPlanApprovalValid(refreshed)).toBe(false);
  });

  it('keeps canonical platform hashes stable across object key order', () => {
    const first = createPlatformVariant({
      id: 'variant-1',
      revisionId: 'revision-1',
      platform: 'wechat',
      title: null,
      bodyMarkdown: null,
      media: null,
      platformFields: { z: 1, nested: { b: true, a: false } },
      createdAt: CREATED_AT,
    });
    const second = createPlatformVariant({
      id: 'variant-2',
      revisionId: 'revision-1',
      platform: 'wechat',
      title: null,
      bodyMarkdown: null,
      media: null,
      platformFields: { nested: { a: false, b: true }, z: 1 },
      createdAt: CREATED_AT,
    });

    expect(first.contentHash).toBe(second.contentHash);
  });

  it('binds target platform fields into the approval content hash', () => {
    const { revision, variant } = createFixture();
    const baseTarget = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.REMOTE_DRAFT,
      scheduledAt: null,
      platformFields: { digest: 'first digest' },
    } as const;

    const first = createPublishPlan({
      id: 'plan-target-1',
      revision,
      variants: [variant],
      targets: [baseTarget],
      createdAt: CREATED_AT,
    });
    const changed = createPublishPlan({
      id: 'plan-target-2',
      revision,
      variants: [variant],
      targets: [
        {
          ...baseTarget,
          platformFields: { digest: 'changed digest' },
        },
      ],
      createdAt: CREATED_AT,
    });

    expect(changed.contentHash).not.toBe(first.contentHash);
  });
});

describe('persistence schemas', () => {
  it('validates every persisted entity at the storage boundary', () => {
    const values = [
      [
        ContentItemSchema,
        {
          id: 'content-1',
          kind: ContentKind.ARTICLE,
          title: 'Title',
          currentRevisionId: 'revision-1',
          source: { importer: 'knowcraft', sourceId: 'source-1', sourceHash: HASH_A },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      ],
      [
        MediaAssetSchema,
        {
          id: 'asset-1',
          kind: ContentKind.IMAGE_POST,
          sha256: HASH_A,
          storagePath: 'media/asset-1.png',
          originalName: '01-card.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: 1086,
          height: 1448,
          durationMs: null,
          createdAt: CREATED_AT,
        },
      ],
      [
        PlatformVariantSchema,
        {
          id: 'variant-1',
          revisionId: 'revision-1',
          platform: 'wechat',
          title: null,
          bodyMarkdown: null,
          media: null,
          platformFields: {},
          contentHash: HASH_A,
          createdAt: CREATED_AT,
        },
      ],
      [
        AccountConnectionSchema,
        {
          id: 'account-1',
          platform: 'wechat',
          externalAccountId: null,
          displayName: 'Official Account',
          deliveryMode: DeliveryMode.REMOTE_DRAFT,
          credentialRef: null,
          enabled: true,
          capabilitiesCheckedAt: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      ],
      [
        PublishPlanSchema,
        {
          id: 'plan-1',
          revisionId: 'revision-1',
          variantIds: ['variant-1'],
          targets: [],
          contentHash: HASH_A,
          approval: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      ],
      [
        PublishJobSchema,
        {
          id: 'job-1',
          planId: 'plan-1',
          revisionId: 'revision-1',
          variantId: 'variant-1',
          accountId: 'account-1',
          platform: 'wechat',
          deliveryMode: DeliveryMode.REMOTE_DRAFT,
          state: JobState.DRAFT,
          idempotencyKey: `publish_${HASH_A}`,
          scheduledAt: null,
          attemptCount: 0,
          remotePublicationId: null,
          statusMessage: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      ],
      [
        PublishAttemptSchema,
        {
          id: 'attempt-1',
          jobId: 'job-1',
          attemptNumber: 1,
          state: JobState.PREPARING,
          startedAt: CREATED_AT,
          finishedAt: null,
          receiptId: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
      [
        RunArtifactSchema,
        {
          id: 'artifact-1',
          jobId: 'job-1',
          attemptId: 'attempt-1',
          kind: 'SCREENSHOT',
          storagePath: 'artifacts/failure.png',
          mimeType: 'image/png',
          sha256: HASH_A,
          createdAt: CREATED_AT,
        },
      ],
    ] as const;

    for (const [schema, value] of values) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects invalid hashes instead of persisting unverifiable content', () => {
    const result = MediaAssetSchema.safeParse({
      id: 'asset-1',
      kind: ContentKind.IMAGE_POST,
      sha256: 'not-a-hash',
      storagePath: 'media/asset.png',
      originalName: 'asset.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      width: null,
      height: null,
      durationMs: null,
      createdAt: CREATED_AT,
    });

    expect(result.success).toBe(false);
  });
});

describe('publish idempotency', () => {
  it('generates the same key for the same semantic submission', () => {
    const input = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.DIRECT_API,
      contentHash: '15d551c39f077a735c9fe5d27b95252a21dc4b81a4300c77cdb019c7e1f26aa1',
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>Hello</p>', nested: { b: 2, a: 1 } },
    } as const;

    expect(createPublishIdempotencyKey({ ...input })).toBe(createPublishIdempotencyKey(input));
    expect(
      createPublishIdempotencyKey({
        ...input,
        platformFields: { nested: { a: 1, b: 2 }, bodyHtml: '<p>Hello</p>' },
      }),
    ).toBe(createPublishIdempotencyKey(input));
  });

  it('changes the key when the approved content changes', () => {
    const base = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.DIRECT_API,
      contentHash: HASH_A,
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>A</p>' },
    } as const;

    expect(createPublishIdempotencyKey({ ...base, contentHash: HASH_B })).not.toBe(
      createPublishIdempotencyKey(base),
    );
  });

  it('changes the key when target platform fields change', () => {
    const base = {
      accountId: 'account-1',
      platform: 'wechat',
      deliveryMode: DeliveryMode.DIRECT_API,
      contentHash: HASH_A,
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>A</p>' },
    } as const;

    expect(
      createPublishIdempotencyKey({
        ...base,
        platformFields: { bodyHtml: '<p>B</p>' },
      }),
    ).not.toBe(createPublishIdempotencyKey(base));
  });
});
