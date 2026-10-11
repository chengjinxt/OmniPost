import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentKind } from '../../domain/index.js';
import { ContentRepository } from './content-repository.js';
import { openDatabase } from './database.js';

describe('ContentRepository', () => {
  let database: BetterSqlite3.Database;
  let repository: ContentRepository;
  let nextId: number;

  beforeEach(() => {
    database = openDatabase(':memory:');
    nextId = 0;
    repository = new ContentRepository(
      database,
      () => `id-${++nextId}`,
      () => new Date(`2026-10-12T00:00:0${nextId}.000Z`),
    );
  });

  afterEach(() => {
    database.close();
  });

  it('creates an immutable first revision and lists it as current', () => {
    const created = repository.create({
      kind: ContentKind.ARTICLE,
      title: '第一篇',
      bodyMarkdown: '# 正文',
      media: [],
      sourceHash: null,
      sourceType: 'MANUAL',
    });

    expect(created.item).toMatchObject({
      id: 'id-1',
      currentRevisionId: 'id-2',
      title: '第一篇',
    });
    expect(created.revision).toMatchObject({
      id: 'id-2',
      contentItemId: 'id-1',
      revisionNumber: 1,
      title: '第一篇',
    });
    expect(repository.list()).toEqual([created]);
  });

  it('appends a revision without mutating the previous one', () => {
    const first = repository.create({
      kind: ContentKind.ARTICLE,
      title: '初稿',
      bodyMarkdown: 'v1',
      media: [],
      sourceHash: null,
      sourceType: 'MANUAL',
    });

    const second = repository.revise(first.item.id, {
      title: '第二稿',
      bodyMarkdown: 'v2',
    });

    expect(second.revision).toMatchObject({ revisionNumber: 2, title: '第二稿', bodyMarkdown: 'v2' });
    expect(repository.getRevision(first.revision.id)).toEqual(first.revision);
    expect(repository.get(first.item.id)?.revision.id).toBe(second.revision.id);
  });

  it('cancels old pending jobs and clears approval when content changes', () => {
    const first = repository.create({
      kind: ContentKind.ARTICLE,
      title: '待发布',
      bodyMarkdown: 'approved body',
      media: [],
      sourceHash: null,
      sourceType: 'MANUAL',
    });
    seedApprovedPlan(database, first.item.id, first.revision.id, first.revision.contentHash);

    repository.revise(first.item.id, { bodyMarkdown: 'edited body' });

    expect(database.prepare(`
      SELECT approval_hash, approved_by, approved_at
      FROM publish_plans WHERE id = ?
    `).get('plan-1')).toEqual({
      approval_hash: null,
      approved_by: null,
      approved_at: null,
    });
    expect(database.prepare(`
      SELECT state, status_message
      FROM publish_jobs WHERE id = ?
    `).get('job-1')).toEqual({
      state: 'CANCELLED',
      status_message: 'Content changed; create a new publish plan',
    });
  });
});

function seedApprovedPlan(
  database: BetterSqlite3.Database,
  contentItemId: string,
  revisionId: string,
  contentHash: string,
): void {
  const now = '2026-10-12T00:00:00.000Z';
  database.prepare(`
    INSERT INTO account_connections (
      id, platform, display_name, credential_ref, capabilities_json, status, created_at, updated_at
    ) VALUES ('account-1', 'WECHAT', '公众号', NULL, '{}', 'CONNECTED', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO publish_plans (
      id, revision_id, scheduled_at, timezone, approval_hash, approved_at, created_at, updated_at,
      variant_ids_json, targets_json, content_hash
    ) VALUES ('plan-1', ?, NULL, 'Asia/Shanghai', ?, ?, ?, ?, '[]', '[]', ?)
  `).run(revisionId, contentHash, now, now, now, contentHash);
  database.prepare(`
    INSERT INTO publish_jobs (
      id, plan_id, account_id, platform, variant_id, state, idempotency_key,
      scheduled_at, created_at, updated_at, revision_id, delivery_mode, attempt_count
    ) VALUES ('job-1', 'plan-1', 'account-1', 'WECHAT', NULL, 'APPROVED', ?, NULL, ?, ?, ?, 'DIRECT_API', 0)
  `).run(`key-${contentItemId}`, now, now, revisionId);
}
