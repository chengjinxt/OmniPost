import type BetterSqlite3 from 'better-sqlite3';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ContentKind,
  ImportCandidateSchema,
  ImportPreviewSchema,
} from '../../domain/index.js';
import { ContentRepository } from '../infrastructure/content-repository.js';
import { openDatabase } from '../infrastructure/database.js';
import {
  GenericMarkdownImporter,
  KnowCraftImporter,
  PersistentSourceImporterAdapter,
} from './index.js';

const temporaryRoots: string[] = [];
const databases: BetterSqlite3.Database[] = [];

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'omnipost-persistent-importer-'));
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const mediaStoreRoot = join(root, 'media-store');
  await mkdir(sourceRoot, { recursive: true });
  return { root, sourceRoot, mediaStoreRoot };
}

function createPersistence(localImporter: GenericMarkdownImporter | KnowCraftImporter, mediaStoreRoot: string) {
  const database = openDatabase(':memory:');
  databases.push(database);
  const repository = new ContentRepository(database);
  const importer = new PersistentSourceImporterAdapter({
    localImporter,
    database,
    repository,
    mediaStoreRoot,
  });
  return { database, repository, importer };
}

async function countStoredFiles(root: string): Promise<number> {
  let count = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile()) count += 1;
    }
  }
  await visit(root);
  return count;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PersistentSourceImporterAdapter', () => {
  it('maps document candidates and previews to strict domain DTOs without treating attachments as media', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace();
    await writeFile(join(sourceRoot, 'image.png'), 'image bytes', 'utf8');
    await writeFile(join(sourceRoot, 'clip.mp4'), 'video bytes', 'utf8');
    await writeFile(join(sourceRoot, 'notes.zip'), 'attachment bytes', 'utf8');
    await writeFile(
      join(sourceRoot, 'article.md'),
      [
        '---',
        'title: Domain article',
        'category: anonymous',
        '---',
        '',
        'Body.',
        '',
        '![image](image.png)',
        '',
        '视频：[clip](clip.mp4)',
        '',
        '附件：[notes](notes.zip)',
      ].join('\n'),
      'utf8',
    );
    const localImporter = new GenericMarkdownImporter({ mediaStoreRoot });
    const { importer } = createPersistence(localImporter, mediaStoreRoot);

    const [candidate] = await importer.discover(sourceRoot);
    const preview = await importer.preview(candidate!);

    expect(ImportCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(candidate).toMatchObject({
      importer: 'markdown',
      kind: ContentKind.ARTICLE,
      titleHint: 'Domain article',
      metadata: {
        localCandidate: {
          kind: 'document',
          context: { bodyRelativePath: 'article.md' },
        },
      },
    });
    expect(ImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(preview.media.map((media) => media.kind)).toEqual([
      ContentKind.IMAGE_POST,
      ContentKind.VIDEO,
    ]);
    expect(preview.media.every((media) => /^[a-f0-9]{64}$/.test(media.sha256 ?? ''))).toBe(true);
    expect(preview.warnings).toContain('Attachment is copied but not publishable media: notes.zip');
  });

  it('maps a KnowCraft PNG-only candidate to IMAGE_POST', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace();
    const topic = join(sourceRoot, 'assets', 'anonymous gallery');
    await mkdir(topic, { recursive: true });
    await writeFile(join(topic, '00-cover.png'), 'cover bytes', 'utf8');
    const localImporter = new KnowCraftImporter({ mediaStoreRoot });
    const { importer } = createPersistence(localImporter, mediaStoreRoot);

    const [candidate] = await importer.discover(sourceRoot);
    const preview = await importer.preview(candidate!);

    expect(candidate?.kind).toBe(ContentKind.IMAGE_POST);
    expect(preview.bodyMarkdown).toBe('');
    expect(preview.media).toHaveLength(1);
    expect(preview.media[0]?.kind).toBe(ContentKind.IMAGE_POST);
  });

  it('persists SHA-deduplicated media and returns the same revision for an identical source import', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace();
    await writeFile(join(sourceRoot, 'one.png'), 'same image bytes', 'utf8');
    await writeFile(join(sourceRoot, 'two.png'), 'same image bytes', 'utf8');
    await writeFile(join(sourceRoot, 'notes.bin'), 'attachment bytes', 'utf8');
    await writeFile(
      join(sourceRoot, 'article.md'),
      '# Deduplicated\n\n![one](one.png)\n\n![two](two.png)\n\n附件：[notes](notes.bin)\n',
      'utf8',
    );
    const localImporter = new GenericMarkdownImporter({ mediaStoreRoot });
    const { database, importer } = createPersistence(localImporter, mediaStoreRoot);
    const [candidate] = await importer.discover(sourceRoot);

    const first = await importer.ingest(candidate!);
    const repeated = await importer.ingest(candidate!);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ revisionNumber: 1, kind: ContentKind.ARTICLE });
    expect(first.media).toHaveLength(2);
    expect(first.media.map((media) => media.order)).toEqual([0, 1]);
    expect(new Set(first.media.map((media) => media.assetId)).size).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM media_assets').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM content_revisions').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM source_imports').pluck().get()).toBe(1);
    expect(await countStoredFiles(mediaStoreRoot)).toBe(2);
  });

  it('appends a revision for changed content on the same path and invalidates approval', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace();
    const sourcePath = join(sourceRoot, 'article.md');
    await writeFile(sourcePath, '# Version one\n\nBody v1.\n', 'utf8');
    const localImporter = new GenericMarkdownImporter({ mediaStoreRoot });
    const { database, repository, importer } = createPersistence(localImporter, mediaStoreRoot);
    const [firstCandidate] = await importer.discover(sourceRoot);
    const first = await importer.ingest(firstCandidate!);
    seedApprovedPlan(database, first.contentItemId, first.id, first.contentHash);

    await writeFile(sourcePath, '# Version two\n\nBody v2.\n', 'utf8');
    const [secondCandidate] = await importer.discover(sourceRoot);
    const second = await importer.ingest(secondCandidate!);

    expect(second).toMatchObject({
      contentItemId: first.contentItemId,
      revisionNumber: 2,
      title: 'Version two',
      bodyMarkdown: 'Body v2.',
    });
    expect(repository.getRevision(first.id)).toMatchObject({ title: 'Version one', bodyMarkdown: 'Body v1.' });
    expect(database.prepare('SELECT COUNT(*) FROM source_imports').pluck().get()).toBe(2);
    expect(database.prepare('SELECT approval_hash FROM publish_plans WHERE id = ?').pluck().get('plan-1')).toBeNull();
    expect(database.prepare('SELECT state FROM publish_jobs WHERE id = ?').pluck().get('job-1')).toBe(
      'CANCELLED',
    );
    const sourceJson = database.prepare('SELECT source_json FROM content_items WHERE id = ?').pluck()
      .get(first.contentItemId) as string;
    expect(JSON.parse(sourceJson)).toMatchObject({ sourceHash: secondCandidate?.sourceHash });
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
