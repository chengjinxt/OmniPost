import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import {
  ContentAddressedMediaStore,
  sha256Bytes,
  sha256File,
  sourceFingerprint,
} from './content-store.js';
import {
  extractMarkdownMedia,
  filenameTitle,
  isExternalMediaTarget,
  parseMarkdown,
} from './markdown.js';
import {
  assertRelativeTarget,
  PathSafetyError,
  resolveSafeExistingPath,
  resolveSafeRoot,
  walkSafeFiles,
} from './safety.js';
import type {
  ContentRevision,
  ImportCandidate,
  ImportMediaPreview,
  ImportPreview,
  ImporterKind,
  ImporterOptions,
  SourceImporter,
} from './types.js';

export class SourceChangedError extends Error {
  constructor(path: string) {
    super(`Source changed after discovery: ${path}`);
    this.name = 'SourceChangedError';
  }
}

export class GenericMarkdownImporter implements SourceImporter {
  protected readonly importer: ImporterKind;
  protected readonly mediaStore: ContentAddressedMediaStore;

  constructor(options: ImporterOptions, importer: ImporterKind = 'markdown') {
    this.importer = importer;
    this.mediaStore = new ContentAddressedMediaStore(options.mediaStoreRoot);
  }

  async discover(root: string): Promise<ImportCandidate[]> {
    const sourceRoot = await resolveSafeRoot(root);
    const files = await walkSafeFiles(sourceRoot, {
      extensions: new Set(['.md', '.markdown', '.mk']),
      excludedNames: new Set(['.git', 'backup', 'node_modules']),
    });
    const candidates = await Promise.all(files.map((path) => this.candidateFromFile(sourceRoot, path)));
    return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  }

  async preview(candidate: ImportCandidate): Promise<ImportPreview> {
    this.assertCandidate(candidate);
    const currentCandidate = await this.candidateFromFile(candidate.sourceRoot, candidate.sourcePath);
    if (
      currentCandidate.relativePath !== candidate.relativePath ||
      currentCandidate.documentHash !== candidate.documentHash ||
      currentCandidate.sourceHash !== candidate.sourceHash
    ) {
      throw new SourceChangedError(candidate.sourcePath);
    }
    const sourcePath = await resolveSafeExistingPath(candidate.sourceRoot, candidate.sourcePath, 'file');
    const bytes = await readFile(sourcePath);
    const parsed = parseMarkdown(bytes, sourcePath, {
      fallbackTitle: (path) => this.fallbackTitle(path),
      stripTelegramBlock: this.importer === 'tgexporter',
    });
    const warnings: string[] = [];
    const media: ImportMediaPreview[] = [];
    for (const reference of extractMarkdownMedia(parsed.bodyMarkdown)) {
      if (!reference.target) continue;
      if (isExternalMediaTarget(reference.target)) {
        warnings.push(`Remote media was not copied: ${reference.target}`);
        continue;
      }
      assertRelativeTarget(reference.target);
      const targetPath = resolve(dirname(sourcePath), reference.target);
      try {
        const safeTarget = await resolveSafeExistingPath(candidate.sourceRoot, targetPath, 'file');
        media.push({
          kind: reference.kind,
          order: media.length,
          sourcePath: safeTarget,
          originalName: basename(safeTarget),
        });
      } catch (error) {
        if (error instanceof PathSafetyError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        warnings.push(`Local media is missing: ${reference.target}`);
      }
    }

    return {
      candidate,
      kind: candidate.kind,
      title: parsed.title,
      bodyMarkdown: parsed.bodyMarkdown,
      frontmatter: parsed.frontmatter,
      media,
      metadata: this.metadataFor(candidate, parsed.frontmatter),
      warnings,
    };
  }

  async ingest(candidate: ImportCandidate): Promise<ContentRevision> {
    const preview = await this.preview(candidate);
    const media = [];
    for (const item of preview.media) {
      const stored = await this.mediaStore.put(candidate.sourceRoot, item.sourcePath);
      media.push({ ...item, ...stored });
    }
    return {
      sourceHash: candidate.sourceHash,
      sourcePath: candidate.sourcePath,
      importer: candidate.importer,
      kind: preview.kind,
      title: preview.title,
      bodyMarkdown: preview.bodyMarkdown,
      metadata: preview.metadata,
      media,
      warnings: preview.warnings,
    };
  }

  protected fallbackTitle(path: string): string {
    return filenameTitle(path);
  }

  protected metadataFor(
    _candidate: ImportCandidate,
    frontmatter: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...frontmatter };
  }

  protected async candidateFromFile(sourceRoot: string, path: string): Promise<ImportCandidate> {
    const safePath = await resolveSafeExistingPath(sourceRoot, path, 'file');
    const bytes = await readFile(safePath);
    const documentHash = sha256Bytes(bytes);
    const relativePath = relative(sourceRoot, safePath).replaceAll('\\', '/');
    const parsed = parseMarkdown(bytes, safePath, {
      fallbackTitle: (value) => this.fallbackTitle(value),
      stripTelegramBlock: this.importer === 'tgexporter',
    });
    const mediaRelativePaths: string[] = [];
    const mediaHashes: Array<readonly [relativePath: string, sha256: string | null]> = [];
    for (const reference of extractMarkdownMedia(parsed.bodyMarkdown)) {
      if (!reference.target || isExternalMediaTarget(reference.target)) continue;
      assertRelativeTarget(reference.target);
      const targetPath = resolve(dirname(safePath), reference.target);
      try {
        const safeTarget = await resolveSafeExistingPath(sourceRoot, targetPath, 'file');
        const mediaRelativePath = relative(sourceRoot, safeTarget).replaceAll('\\', '/');
        mediaRelativePaths.push(mediaRelativePath);
        mediaHashes.push([mediaRelativePath, await sha256File(safeTarget)]);
      } catch (error) {
        if (error instanceof PathSafetyError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mediaHashes.push([reference.target.replaceAll('\\', '/'), null]);
      }
    }
    const sourceHash = sourceFingerprint(this.importer, relativePath, documentHash, mediaHashes);
    return {
      id: `${this.importer}:${sourceHash}`,
      importer: this.importer,
      kind: 'document',
      sourceRoot,
      sourcePath: safePath,
      relativePath,
      titleHint: parsed.title,
      sourceHash,
      documentHash,
      context: {
        bodyRelativePath: relativePath,
        topicRelativePath: null,
        promptsRelativePath: null,
        mediaRelativePaths,
      },
    };
  }

  protected assertCandidate(candidate: ImportCandidate): void {
    if (candidate.importer !== this.importer) {
      throw new Error(`Candidate belongs to ${candidate.importer}, not ${this.importer}.`);
    }
  }
}

export class TgExporterImporter extends GenericMarkdownImporter {
  constructor(options: ImporterOptions) {
    super(options, 'tgexporter');
  }

  protected override fallbackTitle(path: string): string {
    return filenameTitle(path).replace(/^\d{8}_\d{3}_/, '').replace(/^\d{2}_/, '').trim();
  }

  protected override metadataFor(
    candidate: ImportCandidate,
    frontmatter: Record<string, unknown>,
  ): Record<string, unknown> {
    const parts = candidate.relativePath.split('/');
    const batchPart = parts.find((part) => /^第\d+批$/.test(part));
    const archivedBatch = batchPart ? Number(batchPart.slice(1, -1)) : null;
    const techDigest =
      'ranking_method' in frontmatter ||
      ('published_at' in frontmatter && 'url' in frontmatter) ||
      parts.some((part) => part === '科技日报');
    return {
      ...frontmatter,
      dialect: techDigest ? 'tgexporter-tech-digest' : 'tgexporter-standard',
      route: typeof frontmatter.route === 'string' && frontmatter.route ? frontmatter.route : 'default',
      account:
        typeof frontmatter.account === 'string' && frontmatter.account ? frontmatter.account : 'default',
      archivedBatch,
    };
  }
}
