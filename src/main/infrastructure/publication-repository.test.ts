import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ContentKind,
  createContentRevision,
  createPublishIdempotencyKey,
  createPlatformVariant,
} from '../../domain/index.js';
import { openDatabase } from './database.js';
import { PublicationRepository } from './publication-repository.js';

describe('PublicationRepository', () => {
  let database: BetterSqlite3.Database;
  let repository: PublicationRepository;
  let nextId: number;

  beforeEach(() => {
    database = openDatabase(':memory:');
    nextId = 0;
    repository = new PublicationRepository(
      database,
      () => `pub-${++nextId}`,
      () => new Date(`2026-10-12T08:00:0${nextId}.000Z`),
    );
    seedRevisionAndAccounts(database);
  });

  afterEach(() => database.close());

  it('persists platform variants and creates jobs awaiting explicit approval', () => {
    const revision = revisionFixture();
    const variant = createPlatformVariant({
      id: 'variant-1',
      revisionId: revision.id,
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      title: '公众号版本',
      bodyMarkdown: '公众号正文',
      media: [],
      platformFields: { author: 'OmniPost' },
      createdAt: '2026-10-12T08:00:00.000Z',
    });

    repository.saveVariant(variant);
    expect(repository.listVariants(revision.id)).toEqual([variant]);
    const platformFields = {
      __omniPostContentHash: variant.contentHash,
      author: 'OmniPost',
    };
    const result = repository.createPlan({
      revision,
      variants: [variant],
      targets: [{
        accountId: 'account-wechat',
        platform: 'WECHAT_OFFICIAL_ACCOUNT',
        deliveryMode: 'DIRECT_API',
        scheduledAt: null,
        platformFields,
      }],
    });

    expect(result.plan.approval).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      state: 'AWAITING_APPROVAL',
      variantId: 'variant-1',
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      idempotencyKey: createPublishIdempotencyKey({
        accountId: 'account-wechat',
        platform: 'WECHAT_OFFICIAL_ACCOUNT',
        deliveryMode: 'DIRECT_API',
        contentHash: variant.contentHash,
        scheduledAt: null,
        platformFields,
      }),
    });
    expect(repository.getVariant('variant-1')).toEqual(variant);
  });

  it('binds approval to the content hash and schedules only future targets', () => {
    const revision = revisionFixture();
    const targets = [
      {
        accountId: 'account-wechat',
        platform: 'WECHAT_OFFICIAL_ACCOUNT',
        deliveryMode: 'DIRECT_API' as const,
        scheduledAt: null,
        platformFields: {},
      },
      {
        accountId: 'account-youtube',
        platform: 'YOUTUBE',
        deliveryMode: 'DIRECT_API' as const,
        scheduledAt: '2026-10-13T08:00:00.000Z',
        platformFields: {},
      },
    ];
    const created = repository.createPlan({ revision, variants: [], targets });

    const approved = repository.approve(created.plan.id, 'local-user');

    expect(approved.plan.approval).toMatchObject({
      approvedBy: 'local-user',
      contentHash: created.plan.contentHash,
    });
    expect(approved.jobs.map((job) => job.state)).toEqual(['APPROVED', 'SCHEDULED']);
    expect(repository.listJobs().map((job) => job.id)).toEqual(
      approved.jobs.map((job) => job.id),
    );
  });

  it('refuses approval when the persisted revision hash no longer matches the plan', () => {
    const revision = revisionFixture();
    const created = repository.createPlan({ revision, variants: [], targets: [{
      accountId: 'account-wechat',
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      deliveryMode: 'DIRECT_API',
      scheduledAt: null,
      platformFields: {},
    }] });
    database.prepare('UPDATE content_revisions SET content_hash = ? WHERE id = ?')
      .run('f'.repeat(64), revision.id);

    expect(() => repository.approve(created.plan.id, 'local-user'))
      .toThrow('内容已变化');
  });

  it('refuses approval when the plan revision is no longer current', () => {
    const revision = revisionFixture();
    const created = repository.createPlan({ revision, variants: [], targets: [{
      accountId: 'account-wechat',
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      deliveryMode: 'DIRECT_API',
      scheduledAt: null,
      platformFields: {},
    }] });
    const replacement = createContentRevision({
      id: 'revision-2',
      contentItemId: revision.contentItemId,
      revisionNumber: 2,
      kind: revision.kind,
      title: revision.title,
      bodyMarkdown: '修改后的正文',
      media: [],
      sourceHash: null,
      createdAt: '2026-10-12T08:01:00.000Z',
    });
    database.prepare(`
      INSERT INTO content_revisions (
        id, item_id, revision_number, title, body_markdown, body_html,
        media_manifest_json, source_metadata_json, content_hash, created_at, kind, source_hash
      ) VALUES (?, ?, ?, ?, ?, '', '[]', '{}', ?, ?, ?, NULL)
    `).run(
      replacement.id,
      replacement.contentItemId,
      replacement.revisionNumber,
      replacement.title,
      replacement.bodyMarkdown,
      replacement.contentHash,
      replacement.createdAt,
      replacement.kind,
    );
    database.prepare('UPDATE content_items SET current_revision_id = ? WHERE id = ?')
      .run(replacement.id, replacement.contentItemId);

    expect(() => repository.approve(created.plan.id, 'local-user'))
      .toThrow('发布计划不是内容的当前版本');
    expect(repository.listJobs(created.plan.id)).toMatchObject([{
      state: 'AWAITING_APPROVAL',
    }]);
  });
});

function revisionFixture() {
  return createContentRevision({
    id: 'revision-1',
    contentItemId: 'item-1',
    revisionNumber: 1,
    kind: ContentKind.ARTICLE,
    title: '原稿',
    bodyMarkdown: '正文',
    media: [],
    sourceHash: null,
    createdAt: '2026-10-12T08:00:00.000Z',
  });
}

function seedRevisionAndAccounts(database: BetterSqlite3.Database): void {
  const revision = revisionFixture();
  const now = '2026-10-12T08:00:00.000Z';
  database.prepare(`
    INSERT INTO content_items (
      id, title, kind, source_type, created_at, updated_at, current_revision_id
    ) VALUES (?, ?, ?, 'MANUAL', ?, ?, NULL)
  `).run('item-1', revision.title, revision.kind, now, now);
  database.prepare(`
    INSERT INTO content_revisions (
      id, item_id, revision_number, title, body_markdown, body_html,
      media_manifest_json, source_metadata_json, content_hash, created_at, kind, source_hash
    ) VALUES (?, ?, ?, ?, ?, '', '[]', '{}', ?, ?, ?, NULL)
  `).run(
    revision.id,
    revision.contentItemId,
    revision.revisionNumber,
    revision.title,
    revision.bodyMarkdown,
    revision.contentHash,
    revision.createdAt,
    revision.kind,
  );
  database.prepare('UPDATE content_items SET current_revision_id = ? WHERE id = ?')
    .run(revision.id, revision.contentItemId);
  const insert = database.prepare(`
    INSERT INTO account_connections (
      id, platform, display_name, credential_ref, capabilities_json, status,
      created_at, updated_at, delivery_mode
    ) VALUES (?, ?, ?, NULL, '{}', 'CONNECTED', ?, ?, 'DIRECT_API')
  `);
  insert.run('account-wechat', 'WECHAT_OFFICIAL_ACCOUNT', '公众号', now, now);
  insert.run('account-youtube', 'YOUTUBE', 'YouTube', now, now);
}
