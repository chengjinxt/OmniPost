import BetterSqlite3 from 'better-sqlite3';

type DatabaseConnection = BetterSqlite3.Database;

interface Migration {
  version: number;
  up: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    up: `
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

      CREATE INDEX content_revisions_item_idx ON content_revisions(item_id, revision_number DESC);
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
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE content_items ADD COLUMN current_revision_id TEXT REFERENCES content_revisions(id);
      ALTER TABLE content_items ADD COLUMN source_json TEXT;
      UPDATE content_items
      SET current_revision_id = (
        SELECT revision.id
        FROM content_revisions AS revision
        WHERE revision.item_id = content_items.id
        ORDER BY revision.revision_number DESC, revision.created_at DESC, revision.id DESC
        LIMIT 1
      );

      ALTER TABLE content_revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'ARTICLE';
      ALTER TABLE content_revisions ADD COLUMN source_hash TEXT;
      UPDATE content_revisions
      SET kind = (SELECT kind FROM content_items WHERE content_items.id = content_revisions.item_id);

      ALTER TABLE platform_variants ADD COLUMN title TEXT;
      ALTER TABLE platform_variants ADD COLUMN body_markdown TEXT;

      ALTER TABLE account_connections ADD COLUMN external_account_id TEXT;
      ALTER TABLE account_connections ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'UNSUPPORTED';
      ALTER TABLE account_connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
      ALTER TABLE account_connections ADD COLUMN capabilities_checked_at TEXT;

      ALTER TABLE publish_plans ADD COLUMN variant_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE publish_plans ADD COLUMN targets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE publish_plans ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      UPDATE publish_plans
      SET content_hash = COALESCE((
        SELECT revision.content_hash
        FROM content_revisions AS revision
        WHERE revision.id = publish_plans.revision_id
      ), '');

      ALTER TABLE publish_jobs ADD COLUMN revision_id TEXT REFERENCES content_revisions(id);
      ALTER TABLE publish_jobs ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'UNSUPPORTED';
      ALTER TABLE publish_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE publish_jobs ADD COLUMN remote_publication_id TEXT;
      ALTER TABLE publish_jobs ADD COLUMN status_message TEXT;
      UPDATE publish_jobs
      SET revision_id = COALESCE(
        (
          SELECT plan.revision_id
          FROM publish_plans AS plan
          WHERE plan.id = publish_jobs.plan_id
        ),
        (
          SELECT variant.revision_id
          FROM platform_variants AS variant
          WHERE variant.id = publish_jobs.variant_id
        )
      );
      UPDATE publish_jobs
      SET state = CASE
            WHEN state IN ('PUBLISHED', 'REJECTED', 'FAILED', 'CANCELLED') THEN state
            WHEN state IN ('SUBMITTED', 'PROCESSING', 'UNKNOWN') THEN 'NEEDS_ACTION'
            ELSE 'CANCELLED'
          END,
          lease_owner = NULL,
          lease_until = NULL,
          status_message = 'Legacy publish job quarantined during database migration';
      UPDATE publish_plans
      SET approval_hash = NULL,
          approved_at = NULL;

      ALTER TABLE publish_attempts ADD COLUMN receipt_id TEXT;
      ALTER TABLE publish_attempts ADD COLUMN error_code TEXT;
      ALTER TABLE publish_attempts ADD COLUMN error_message TEXT;

      ALTER TABLE run_artifacts ADD COLUMN job_id TEXT REFERENCES publish_jobs(id);
      ALTER TABLE run_artifacts ADD COLUMN mime_type TEXT;
      ALTER TABLE run_artifacts ADD COLUMN sha256 TEXT;
    `,
  },
  {
    version: 3,
    up: `
      ALTER TABLE publish_plans ADD COLUMN approved_by TEXT;
    `,
  },
  {
    version: 4,
    up: `
      CREATE TABLE ai_profiles (
        id TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        base_url_id TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL CHECK (endpoint IN ('RESPONSES', 'CHAT_COMPLETIONS')),
        prompt_version TEXT NOT NULL,
        api_key_ciphertext BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE ai_generation_records (
        variant_id TEXT PRIMARY KEY REFERENCES platform_variants(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        base_url_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    up: `
      DELETE FROM publish_jobs
      WHERE plan_id IS NULL OR revision_id IS NULL;

      ALTER TABLE account_connections
      ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 1 CHECK (binding_version > 0);

      UPDATE publish_jobs
      SET state = CASE
            WHEN state IN ('SUBMITTED', 'PROCESSING', 'UNKNOWN') THEN 'NEEDS_ACTION'
            WHEN state IN ('PUBLISHED', 'REJECTED', 'FAILED', 'CANCELLED', 'NEEDS_ACTION') THEN state
            ELSE 'CANCELLED'
          END,
          lease_owner = NULL,
          lease_until = NULL,
          status_message = 'Legacy account binding quarantined during database migration';

      UPDATE publish_plans
      SET approval_hash = NULL,
          approved_at = NULL,
          approved_by = NULL;
    `,
  },
];

export const DATABASE_VERSION = migrations.at(-1)?.version ?? 0;

function migrate(database: DatabaseConnection): void {
  const currentVersion = database.pragma('user_version', { simple: true }) as number;
  if (currentVersion > DATABASE_VERSION) {
    throw new Error(
      `Cannot open newer database version ${currentVersion}; this application supports up to ${DATABASE_VERSION}`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.up);
      database.pragma(`user_version = ${migration.version}`);
    })();
  }
}

export function openDatabase(databaseOrPath: string | DatabaseConnection): DatabaseConnection {
  const database = typeof databaseOrPath === 'string'
    ? new BetterSqlite3(databaseOrPath)
    : databaseOrPath;

  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  if (!database.memory && !database.readonly) {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
  }

  migrate(database);
  return database;
}
