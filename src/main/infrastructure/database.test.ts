import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ContentRepository } from './content-repository.js';
import { DATABASE_VERSION, openDatabase } from './database.js';
import { PublicationRepository } from './publication-repository.js';

const expectedTables = [
  'account_connections',
  'ai_generation_records',
  'ai_profiles',
  'content_items',
  'content_revisions',
  'media_assets',
  'platform_variants',
  'publish_attempts',
  'publish_jobs',
  'publish_plans',
  'run_artifacts',
  'secrets',
  'source_imports',
];

describe('openDatabase', () => {
  it('applies every migration and enables foreign keys', () => {
    const database = openDatabase(':memory:');

    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .pluck()
        .all();

      expect(tables).toEqual(expectedTables);
      expect(database.pragma('user_version', { simple: true })).toBe(DATABASE_VERSION);
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });

  it('can run migrations repeatedly without losing persisted rows', () => {
    const database = openDatabase(':memory:');

    try {
      database.prepare(`
        INSERT INTO content_items (id, title, kind, source_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('item-1', '第一篇内容', 'ARTICLE', 'MARKDOWN', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');

      openDatabase(database);

      expect(database.prepare('SELECT title FROM content_items WHERE id = ?').pluck().get('item-1')).toBe('第一篇内容');
      expect(database.pragma('user_version', { simple: true })).toBe(DATABASE_VERSION);
    } finally {
      database.close();
    }
  });

  it('upgrades real v1 content and quarantines legacy publish jobs', () => {
    const database = new BetterSqlite3(':memory:');
    const now = '2026-10-12T00:00:00.000Z';

    try {
      database.exec(VERSION_ONE_SCHEMA);
      database.prepare(`
        INSERT INTO content_items (id, title, kind, source_type, created_at, updated_at)
        VALUES ('item-1', '旧内容', 'ARTICLE', 'MARKDOWN', ?, ?)
      `).run(now, now);
      const insertRevision = database.prepare(`
        INSERT INTO content_revisions (
          id, item_id, revision_number, title, body_markdown, body_html,
          media_manifest_json, source_metadata_json, content_hash, created_at
        ) VALUES (?, 'item-1', ?, ?, ?, '', '[]', '{}', ?, ?)
      `);
      insertRevision.run('revision-1', 1, '旧内容', '第一版', 'a'.repeat(64), now);
      insertRevision.run('revision-2', 2, '旧内容第二版', '第二版', 'b'.repeat(64), now);
      database.prepare(`
        INSERT INTO account_connections (
          id, platform, display_name, credential_ref, capabilities_json, status, created_at, updated_at
        ) VALUES ('account-1', 'YOUTUBE', '频道', NULL, '{}', 'CONNECTED', ?, ?)
      `).run(now, now);
      database.prepare(`
        INSERT INTO publish_plans (
          id, revision_id, scheduled_at, timezone, approval_hash, approved_at, created_at, updated_at
        ) VALUES ('plan-1', 'revision-2', NULL, 'Asia/Shanghai', ?, ?, ?, ?)
      `).run('b'.repeat(64), now, now, now);
      database.prepare(`
        INSERT INTO publish_jobs (
          id, plan_id, account_id, platform, variant_id, state, idempotency_key,
          scheduled_at, created_at, updated_at
        ) VALUES (
          'job-1', 'plan-1', 'account-1', 'YOUTUBE', NULL, 'APPROVED',
          ?, NULL, ?, ?
        )
      `).run(`publish_${'c'.repeat(64)}`, now, now);
      database.prepare(`
        INSERT INTO publish_jobs (
          id, plan_id, account_id, platform, variant_id, state, idempotency_key,
          scheduled_at, created_at, updated_at
        ) VALUES (
          'job-orphan', NULL, 'account-1', 'YOUTUBE', NULL, 'DRAFT',
          ?, NULL, ?, ?
        )
      `).run(`publish_${'d'.repeat(64)}`, now, now);
      database.pragma('user_version = 1');

      openDatabase(database);

      expect(new ContentRepository(database).list()).toMatchObject([{
        item: { id: 'item-1', currentRevisionId: 'revision-2' },
        revision: { id: 'revision-2', revisionNumber: 2, bodyMarkdown: '第二版' },
      }]);
      expect(new PublicationRepository(database).listJobs()).toMatchObject([{
        id: 'job-1',
        revisionId: 'revision-2',
        state: 'CANCELLED',
        deliveryMode: 'UNSUPPORTED',
      }]);
      expect(database.prepare("SELECT id FROM publish_jobs WHERE id = 'job-orphan'").get())
        .toBeUndefined();
      expect(database.prepare(`
        SELECT binding_version FROM account_connections WHERE id = 'account-1'
      `).pluck().get()).toBe(1);
      expect(database.prepare(`
        SELECT approval_hash, approved_at, content_hash
        FROM publish_plans WHERE id = 'plan-1'
      `).get()).toEqual({
        approval_hash: null,
        approved_at: null,
        content_hash: 'b'.repeat(64),
      });
      expect(database.pragma('user_version', { simple: true })).toBe(DATABASE_VERSION);
    } finally {
      database.close();
    }
  });

  it('refuses to open a database created by a newer application version', () => {
    const database = new BetterSqlite3(':memory:');

    try {
      database.pragma(`user_version = ${DATABASE_VERSION + 1}`);

      expect(() => openDatabase(database)).toThrow(/newer database version/i);
      expect(database.pragma('user_version', { simple: true })).toBe(DATABASE_VERSION + 1);
    } finally {
      database.close();
    }
  });

  it('enforces account-scoped publishing idempotency', () => {
    const database = openDatabase(':memory:');

    try {
      const now = '2026-10-12T00:00:00.000Z';
      database.prepare(`
        INSERT INTO account_connections (
          id, platform, display_name, credential_ref, capabilities_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('account-1', 'YOUTUBE', '频道', null, '{}', 'CONNECTED', now, now);

      const insert = database.prepare(`
        INSERT INTO publish_jobs (
          id, plan_id, account_id, platform, variant_id, state, idempotency_key,
          scheduled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run('job-1', null, 'account-1', 'YOUTUBE', null, 'APPROVED', 'same-key', null, now, now);

      expect(() => insert.run(
        'job-2', null, 'account-1', 'YOUTUBE', null, 'APPROVED', 'same-key', null, now, now,
      )).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });
});

const VERSION_ONE_SCHEMA = `
  CREATE TABLE content_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ARTICLE', 'IMAGE_POST', 'VIDEO')),
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE content_revisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    media_manifest_json TEXT NOT NULL DEFAULT '[]',
    source_metadata_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (item_id, revision_number)
  );
  CREATE INDEX content_revisions_item_idx
    ON content_revisions(item_id, revision_number DESC);
  CREATE INDEX content_revisions_hash_idx ON content_revisions(content_hash);

  CREATE TABLE media_assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE platform_variants (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('ARTICLE', 'IMAGE_POST', 'VIDEO')),
    fields_json TEXT NOT NULL,
    media_manifest_json TEXT NOT NULL DEFAULT '[]',
    variant_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (revision_id, platform, variant_hash)
  );

  CREATE TABLE account_connections (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    display_name TEXT NOT NULL,
    credential_ref TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE publish_plans (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE RESTRICT,
    scheduled_at TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    approval_hash TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE publish_jobs (
    id TEXT PRIMARY KEY,
    plan_id TEXT REFERENCES publish_plans(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES account_connections(id) ON DELETE RESTRICT,
    platform TEXT NOT NULL,
    variant_id TEXT REFERENCES platform_variants(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN (
      'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PREPARING',
      'SUBMITTED', 'PROCESSING', 'PUBLISHED', 'REJECTED', 'NEEDS_ACTION',
      'FAILED', 'UNKNOWN', 'CANCELLED'
    )),
    idempotency_key TEXT NOT NULL,
    scheduled_at TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    remote_id TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, platform, idempotency_key)
  );
  CREATE INDEX publish_jobs_due_idx ON publish_jobs(state, scheduled_at);

  CREATE TABLE publish_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    receipt_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (job_id, attempt_number)
  );

  CREATE TABLE run_artifacts (
    id TEXT PRIMARY KEY,
    attempt_id TEXT REFERENCES publish_attempts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    redacted INTEGER NOT NULL DEFAULT 1 CHECK (redacted IN (0, 1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX run_artifacts_run_idx ON run_artifacts(run_id);

  CREATE TABLE source_imports (
    id TEXT PRIMARY KEY,
    importer_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES content_revisions(id) ON DELETE CASCADE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    imported_at TEXT NOT NULL,
    UNIQUE (importer_type, source_path, source_hash)
  );

  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account_connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, name)
  );
`;
