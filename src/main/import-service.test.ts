import { describe, expect, it, vi } from 'vitest';

import {
  ContentKind,
  createContentRevision,
  type ImportCandidate,
  type ImportPreview,
  type SourceImporter,
} from '../domain/index.js';
import { ImportService } from './import-service.js';

describe('ImportService', () => {
  it('discovers through a main-process directory chooser and never accepts a renderer path', async () => {
    const importer = importerFixture();
    const chooseDirectory = vi.fn().mockResolvedValue('C:/readonly/source');
    const service = new ImportService({ markdown: importer }, chooseDirectory, contentLookup());

    const result = await service.discover('markdown');

    expect(chooseDirectory).toHaveBeenCalledOnce();
    expect(importer.discover).toHaveBeenCalledWith('C:/readonly/source');
    expect(result).toMatchObject({
      cancelled: false,
      candidates: [{ id: 'candidate-1', title: '导入文章', relativePath: 'article.md' }],
    });
  });

  it('keeps candidates server-side and rejects unknown ids', async () => {
    const service = new ImportService(
      { markdown: importerFixture() },
      async () => 'C:/readonly/source',
      contentLookup(),
    );
    await service.discover('markdown');

    await expect(service.preview('forged-path')).rejects.toThrow('未知的导入候选项');
    await expect(service.ingest('forged-path')).rejects.toThrow('未知的导入候选项');
  });

  it('previews and ingests the exact discovered candidate', async () => {
    const importer = importerFixture();
    const lookup = contentLookup();
    const service = new ImportService(
      { markdown: importer },
      async () => 'C:/readonly/source',
      lookup,
    );
    await service.discover('markdown');

    await expect(service.preview('candidate-1')).resolves.toMatchObject({
      candidateId: 'candidate-1',
      title: '导入文章',
      media: [],
    });
    await expect(service.ingest('candidate-1')).resolves.toMatchObject({
      item: { id: 'item-1' },
      revision: { id: 'revision-1' },
    });
    expect(importer.ingest).toHaveBeenCalledWith(candidate());
    expect(lookup.get).toHaveBeenCalledWith('item-1');
  });
});

function candidate(): ImportCandidate {
  return {
    id: 'candidate-1',
    importer: 'markdown',
    sourceRoot: 'C:/readonly/source',
    sourcePath: 'C:/readonly/source/article.md',
    relativePath: 'article.md',
    titleHint: '导入文章',
    kind: ContentKind.ARTICLE,
    sourceHash: 'a'.repeat(64),
    metadata: {},
  };
}

function preview(): ImportPreview {
  return {
    candidate: candidate(),
    title: '导入文章',
    bodyMarkdown: '# 正文',
    frontmatter: {},
    media: [],
    warnings: [],
  };
}

function revision() {
  return createContentRevision({
    id: 'revision-1',
    contentItemId: 'item-1',
    revisionNumber: 1,
    kind: ContentKind.ARTICLE,
    title: '导入文章',
    bodyMarkdown: '# 正文',
    media: [],
    sourceHash: 'a'.repeat(64),
    createdAt: '2026-10-12T08:00:00.000Z',
  });
}

function importerFixture(): SourceImporter & {
  discover: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
} {
  return {
    discover: vi.fn().mockResolvedValue([candidate()]),
    preview: vi.fn().mockResolvedValue(preview()),
    ingest: vi.fn().mockResolvedValue(revision()),
  };
}

function contentLookup() {
  const document = {
    item: {
      id: 'item-1',
      kind: ContentKind.ARTICLE,
      title: '导入文章',
      currentRevisionId: 'revision-1',
      source: null,
      createdAt: '2026-10-12T08:00:00.000Z',
      updatedAt: '2026-10-12T08:00:00.000Z',
    },
    revision: revision(),
  };
  return { get: vi.fn(() => document) };
}
