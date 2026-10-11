import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GenericMarkdownImporter,
  KnowCraftImporter,
  PathSafetyError,
  SourceChangedError,
  TgExporterImporter,
} from './index.js';

const fixturesRoot = resolve(import.meta.dirname, 'fixtures');
const temporaryRoots: string[] = [];
const temporaryLinks: string[] = [];

async function createWorkspace(fixtureName?: string) {
  const root = await mkdtemp(join(tmpdir(), 'omnipost-importers-'));
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const mediaStoreRoot = join(root, 'media-store');
  await mkdir(sourceRoot, { recursive: true });
  if (fixtureName) {
    await cp(join(fixturesRoot, fixtureName), sourceRoot, { recursive: true });
  }
  return { root, sourceRoot, mediaStoreRoot };
}

async function sha256(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function snapshotTree(root: string) {
  const entries: Array<{ path: string; size: number; modified: number; hash: string }> = [];

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        entries.push({
          path: relative(root, path).replaceAll('\\', '/'),
          size: info.size,
          modified: info.mtimeMs,
          hash: await sha256(path),
        });
      }
    }
  }

  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function listStoredMedia(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return files.sort();
}

afterEach(async () => {
  await Promise.all(temporaryLinks.splice(0).map((path) => unlink(path).catch(() => undefined)));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GenericMarkdownImporter', () => {
  it('uses frontmatter, then H1, then filename for title and resolves local media', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace('generic-markdown');
    const importer = new GenericMarkdownImporter({ mediaStoreRoot });

    const candidates = await importer.discover(sourceRoot);
    const previews = await Promise.all(candidates.map((candidate) => importer.preview(candidate)));

    expect(previews.map((preview) => preview.title)).toEqual([
      'Frontmatter title',
      'Heading title',
      '03 filename fallback',
    ]);
    expect(previews[0]?.bodyMarkdown).not.toContain('# Ignored heading');
    expect(previews[0]?.media.map((media) => media.originalName)).toEqual(['image (one) 🚀.png']);
  });

  it('includes local media bytes in the source hash and rejects media changed after discovery', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace();
    const articlePath = join(sourceRoot, 'article.md');
    const mediaPath = join(sourceRoot, 'asset.png');
    await writeFile(articlePath, '# Article\n\n![asset](asset.png)\n', 'utf8');
    await writeFile(mediaPath, 'first media bytes', 'utf8');
    const importer = new GenericMarkdownImporter({ mediaStoreRoot });
    const [candidate] = await importer.discover(sourceRoot);

    await writeFile(mediaPath, 'second media bytes', 'utf8');

    await expect(importer.preview(candidate!)).rejects.toBeInstanceOf(SourceChangedError);
    const [changedCandidate] = await importer.discover(sourceRoot);
    expect(changedCandidate?.sourceHash).not.toBe(candidate?.sourceHash);
  });
});

describe('TgExporterImporter', () => {
  it('discovers recursive md and mk files, including batch directories and both frontmatter dialects', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace('tgexporter');
    const mixedPath = join(sourceRoot, '20260102', '20260102_004_Mixed lines.mk');
    await writeFile(
      mixedPath,
      '---\r\ntitle: "Mixed line title"\ndate: 2026-01-02 12:00:00\r\nsource: telegram\nchannel: anon\r\nmessage_ids: []\nstatus: rendered\r\n---\n\r\n# Different H1\n\r\nBody.\r\n',
      'utf8',
    );
    const importer = new TgExporterImporter({ mediaStoreRoot });

    const candidates = await importer.discover(sourceRoot);
    const previews = await Promise.all(candidates.map((candidate) => importer.preview(candidate)));

    expect(candidates).toHaveLength(4);
    expect(candidates.some((candidate) => candidate.relativePath.includes('/第1批/'))).toBe(true);
    expect(candidates.some((candidate) => candidate.relativePath.endsWith('.mk'))).toBe(true);

    const current = previews.find((preview) => preview.title === 'Frontmatter wins');
    expect(current?.metadata).toMatchObject({
      dialect: 'tgexporter-standard',
      route: 'default',
      account: 'default',
    });
    expect(current?.media.map((media) => [media.kind, media.originalName])).toEqual([
      ['image', 'shared image (1) 🚀.png'],
    ]);

    const archived = previews.find((preview) => preview.title === '批次 🚀 文章');
    expect(archived?.metadata).toMatchObject({ archivedBatch: 1, route: 'default', account: 'default' });
    expect(archived?.media.map((media) => media.kind)).toEqual(['image', 'video']);

    const digest = previews.find((preview) => preview.title === '匿名科技日报');
    expect(digest?.metadata).toMatchObject({ dialect: 'tgexporter-tech-digest' });
    expect(digest?.bodyMarkdown).not.toContain('TELEGRAM_MESSAGE_BEGIN');
    expect(digest?.bodyMarkdown).not.toContain('telegram-only');
    expect(digest?.media.map((media) => media.kind)).toEqual(['image', 'video']);
  });

  it('copies media by SHA-256, deduplicates equal bytes, and never changes the source tree', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace('tgexporter');
    const importer = new TgExporterImporter({ mediaStoreRoot });
    const before = await snapshotTree(sourceRoot);
    const candidates = await importer.discover(sourceRoot);
    const selected = candidates.filter((candidate) => !candidate.relativePath.endsWith('.mk'));

    const first = await Promise.all(selected.map((candidate) => importer.ingest(candidate)));
    const second = await Promise.all(selected.map((candidate) => importer.ingest(candidate)));

    expect(second.map((revision) => revision.sourceHash)).toEqual(
      first.map((revision) => revision.sourceHash),
    );
    expect(await snapshotTree(sourceRoot)).toEqual(before);
    const stored = await listStoredMedia(mediaStoreRoot);
    const uniqueHashes = new Set(first.flatMap((revision) => revision.media.map((media) => media.sha256)));
    expect(stored).toHaveLength(uniqueHashes.size);
    expect(stored.every((path) => /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path))).toBe(true);
  }, 15_000);
});

describe('KnowCraftImporter', () => {
  it('discovers only first-level assets topics and applies body candidate rules', async () => {
    const { sourceRoot, mediaStoreRoot } = await createWorkspace('knowcraft');
    const assetsRoot = join(sourceRoot, 'assets');
    await mkdir(join(assetsRoot, '.git'), { recursive: true });
    await writeFile(join(assetsRoot, '.git', 'ignored.md'), '# Git metadata\n', 'utf8');
    await writeFile(join(assetsRoot, 'AGENTS.md'), '# Must be excluded\n', 'utf8');
    await writeFile(
      join(assetsRoot, '20260101_01_topic-cards', 'AGENTS.md'),
      '# Must not become body content\n',
      'utf8',
    );
    const importer = new KnowCraftImporter({ mediaStoreRoot });

    const candidates = await importer.discover(sourceRoot);
    const previews = await Promise.all(candidates.map((candidate) => importer.preview(candidate)));

    expect(candidates).toHaveLength(5);
    expect(previews.map((preview) => preview.title).sort()).toEqual(
      ['Gallery only', 'First candidate', 'Second candidate', 'README fallback', 'Standalone article'].sort(),
    );
    expect(candidates.every((candidate) => !/backup|\.git|AGENTS|\.txt/i.test(candidate.relativePath))).toBe(
      true,
    );

    const standalone = previews.find((preview) => preview.title === 'Standalone article');
    expect(standalone?.bodyMarkdown).not.toContain('PROMPT-ONLY');
    expect(standalone?.metadata.promptsMarkdown).toContain('PROMPT-ONLY');
    expect(standalone?.media.map((media) => media.originalName)).toEqual([
      '00-cover.png',
      '2_card.png',
      '10-card.png',
      '附加 图.png',
    ]);

    const gallery = previews.find((preview) => preview.title === 'Gallery only');
    expect(gallery?.kind).toBe('media-only');
    expect(gallery?.bodyMarkdown).toBe('');
    expect(gallery?.media).toHaveLength(2);
  });
});

describe('source path safety', () => {
  it('rejects media paths that escape the source root', async () => {
    const { root, sourceRoot, mediaStoreRoot } = await createWorkspace();
    await writeFile(join(root, 'outside.png'), 'outside', 'utf8');
    await writeFile(join(sourceRoot, 'article.md'), '# Safe title\n\n![escape](../outside.png)\n', 'utf8');
    const importer = new GenericMarkdownImporter({ mediaStoreRoot });

    await expect(importer.discover(sourceRoot)).rejects.toBeInstanceOf(PathSafetyError);
  });

  it('rejects symbolic links and Windows directory junctions instead of traversing them', async () => {
    const { root, sourceRoot, mediaStoreRoot } = await createWorkspace();
    const assets = join(sourceRoot, 'assets');
    const outside = join(root, 'outside-topic');
    await mkdir(assets, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'article.md'), '# Linked article\n', 'utf8');
    const link = join(assets, 'linked-topic');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryLinks.push(link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const importer = new KnowCraftImporter({ mediaStoreRoot });

    await expect(importer.discover(sourceRoot)).rejects.toBeInstanceOf(PathSafetyError);
  });

  it('rejects a selected root located below a symbolic-link or junction ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omnipost-import-root-link-'));
    temporaryRoots.push(root);
    const actualRoot = join(root, 'actual-source');
    const nestedRoot = join(actualRoot, 'nested');
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(nestedRoot, 'article.md'), '# Linked root\n', 'utf8');
    const linkedRoot = join(root, 'linked-source');
    await symlink(actualRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    temporaryLinks.push(linkedRoot);
    const importer = new GenericMarkdownImporter({ mediaStoreRoot: join(root, 'media-store') });

    await expect(importer.discover(join(linkedRoot, 'nested')))
      .rejects.toBeInstanceOf(PathSafetyError);
  });
});
