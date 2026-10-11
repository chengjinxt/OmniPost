import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import {
  ContentKind,
  ImportCandidateSchema,
  ImportPreviewSchema,
  JsonObjectSchema,
  type ContentRevision,
  type ImportCandidate as DomainImportCandidate,
  type ImportPreview as DomainImportPreview,
  type RevisionMedia,
  type SourceImporter as DomainSourceImporter,
} from '../../domain/index.js';
import type { ContentRepository } from '../infrastructure/content-repository.js';
import { sha256File } from './content-store.js';
import { PathSafetyError } from './safety.js';
import type {
  ImportCandidate as LocalImportCandidate,
  ImportCandidateContext,
  ImportCandidateKind,
  ImportedMedia,
  SourceImporter as LocalSourceImporter,
} from './types.js';

export interface PersistentSourceImporterAdapterOptions {
  localImporter: LocalSourceImporter;
  database: BetterSqlite3.Database;
  repository: ContentRepository;
  mediaStoreRoot: string;
  createId?: () => string;
  now?: () => Date;
}

interface StoredMediaInput {
  sha256: string;
  relativePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

interface SourceImportRow {
  revision_id: string;
}

interface PreviousSourceRow {
  item_id: string;
}

function domainKind(kind: ImportCandidateKind): typeof ContentKind.ARTICLE | typeof ContentKind.IMAGE_POST {
  return kind === 'media-only' ? ContentKind.IMAGE_POST : ContentKind.ARTICLE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function decodeLocalMetadata(candidate: DomainImportCandidate): {
  kind: ImportCandidateKind;
  documentHash: string;
  context: ImportCandidateContext;
} {
  const envelope = candidate.metadata.localCandidate;
  if (!isRecord(envelope)) throw new Error('Import candidate is missing localCandidate metadata.');
  const kind = envelope.kind;
  const documentHash = envelope.documentHash;
  const context = envelope.context;
  if ((kind !== 'document' && kind !== 'media-only') || typeof documentHash !== 'string') {
    throw new Error('Import candidate has invalid local kind or document hash metadata.');
  }
  if (!isRecord(context)) throw new Error('Import candidate has invalid local context metadata.');
  const bodyRelativePath = context.bodyRelativePath;
  const topicRelativePath = context.topicRelativePath;
  const promptsRelativePath = context.promptsRelativePath;
  const mediaRelativePaths = context.mediaRelativePaths;
  if (
    !stringOrNull(bodyRelativePath) ||
    !stringOrNull(topicRelativePath) ||
    !stringOrNull(promptsRelativePath) ||
    !Array.isArray(mediaRelativePaths) ||
    !mediaRelativePaths.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Import candidate has invalid local path context metadata.');
  }
  if (candidate.kind !== domainKind(kind)) {
    throw new Error('Import candidate kind does not match its local metadata.');
  }
  return {
    kind,
    documentHash,
    context: {
      bodyRelativePath,
      topicRelativePath,
      promptsRelativePath,
      mediaRelativePaths,
    },
  };
}

function mimeTypeFor(name: string): string {
  switch (extname(name).toLocaleLowerCase('en-US')) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    default:
      return 'application/octet-stream';
  }
}

export class PersistentSourceImporterAdapter implements DomainSourceImporter {
  private readonly localImporter: LocalSourceImporter;
  private readonly database: BetterSqlite3.Database;
  private readonly repository: ContentRepository;
  private readonly mediaStoreRoot: string;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(options: PersistentSourceImporterAdapterOptions) {
    this.localImporter = options.localImporter;
    this.database = options.database;
    this.repository = options.repository;
    this.mediaStoreRoot = resolve(options.mediaStoreRoot);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public async discover(root: string): Promise<DomainImportCandidate[]> {
    const candidates = await this.localImporter.discover(root);
    return candidates.map((candidate) => this.toDomainCandidate(candidate));
  }

  public async preview(candidate: DomainImportCandidate): Promise<DomainImportPreview> {
    const domainCandidate = ImportCandidateSchema.parse(candidate);
    const preview = await this.localImporter.preview(this.toLocalCandidate(domainCandidate));
    const warnings = [...preview.warnings];
    const media: DomainImportPreview['media'] = [];
    for (const item of preview.media) {
      if (item.kind === 'attachment') {
        warnings.push(`Attachment is copied but not publishable media: ${item.originalName}`);
        continue;
      }
      media.push({
        sourcePath: item.sourcePath,
        originalName: item.originalName,
        kind: item.kind === 'image' ? ContentKind.IMAGE_POST : ContentKind.VIDEO,
        order: media.length,
        sha256: await sha256File(item.sourcePath),
      });
    }
    return ImportPreviewSchema.parse({
      candidate: domainCandidate,
      title: preview.title,
      bodyMarkdown: preview.bodyMarkdown,
      frontmatter: JsonObjectSchema.parse(JSON.parse(JSON.stringify(preview.frontmatter))),
      media,
      warnings,
    });
  }

  public async ingest(candidate: DomainImportCandidate): Promise<ContentRevision> {
    const domainCandidate = ImportCandidateSchema.parse(candidate);
    const existing = this.findExactImport(domainCandidate);
    if (existing) return existing;

    const imported = await this.localImporter.ingest(this.toLocalCandidate(domainCandidate));
    if (imported.sourceHash !== domainCandidate.sourceHash) {
      throw new Error('Local importer returned a different source hash.');
    }
    const storedMedia = await this.prepareStoredMedia(imported.media);

    return this.database.transaction(() => {
      const concurrentExisting = this.findExactImport(domainCandidate);
      if (concurrentExisting) return concurrentExisting;

      const revisionMedia: RevisionMedia[] = storedMedia.map((item, order) => ({
        assetId: this.ensureMediaAsset(item),
        sha256: item.sha256,
        order,
      }));
      const previous = this.findPreviousSource(domainCandidate);
      const source = {
        importer: domainCandidate.importer,
        sourceId: domainCandidate.sourcePath,
        sourceHash: domainCandidate.sourceHash,
      };
      const document = previous
        ? this.repository.revise(previous.item_id, {
            kind: domainCandidate.kind,
            title: imported.title,
            bodyMarkdown: imported.bodyMarkdown,
            media: revisionMedia,
            sourceHash: domainCandidate.sourceHash,
          })
        : this.repository.create({
            kind: domainCandidate.kind,
            title: imported.title,
            bodyMarkdown: imported.bodyMarkdown,
            media: revisionMedia,
            sourceHash: domainCandidate.sourceHash,
            sourceType: domainCandidate.importer,
            source,
          });

      this.database.prepare('UPDATE content_items SET source_json = ? WHERE id = ?')
        .run(JSON.stringify(source), document.item.id);
      this.database.prepare(`
        INSERT INTO source_imports (
          id, importer_type, source_path, source_hash, revision_id, metadata_json, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.createId(),
        domainCandidate.importer,
        domainCandidate.sourcePath,
        domainCandidate.sourceHash,
        document.revision.id,
        JSON.stringify(domainCandidate.metadata),
        this.now().toISOString(),
      );
      return document.revision;
    }).immediate();
  }

  private toDomainCandidate(candidate: LocalImportCandidate): DomainImportCandidate {
    return ImportCandidateSchema.parse({
      id: candidate.id,
      importer: candidate.importer,
      sourceRoot: candidate.sourceRoot,
      sourcePath: candidate.sourcePath,
      relativePath: candidate.relativePath,
      titleHint: candidate.titleHint,
      kind: domainKind(candidate.kind),
      sourceHash: candidate.sourceHash,
      metadata: {
        localCandidate: {
          kind: candidate.kind,
          documentHash: candidate.documentHash,
          context: {
            bodyRelativePath: candidate.context.bodyRelativePath,
            topicRelativePath: candidate.context.topicRelativePath,
            promptsRelativePath: candidate.context.promptsRelativePath,
            mediaRelativePaths: [...candidate.context.mediaRelativePaths],
          },
        },
      },
    });
  }

  private toLocalCandidate(candidate: DomainImportCandidate): LocalImportCandidate {
    const local = decodeLocalMetadata(candidate);
    return {
      id: candidate.id,
      importer: candidate.importer as LocalImportCandidate['importer'],
      kind: local.kind,
      sourceRoot: candidate.sourceRoot,
      sourcePath: candidate.sourcePath,
      relativePath: candidate.relativePath,
      titleHint: candidate.titleHint,
      sourceHash: candidate.sourceHash,
      documentHash: local.documentHash,
      context: local.context,
    };
  }

  private findExactImport(candidate: DomainImportCandidate): ContentRevision | undefined {
    const row = this.database.prepare(`
      SELECT revision_id
      FROM source_imports
      WHERE importer_type = ? AND source_path = ? AND source_hash = ?
    `).get(candidate.importer, candidate.sourcePath, candidate.sourceHash) as SourceImportRow | undefined;
    if (!row) return undefined;
    const revision = this.repository.getRevision(row.revision_id);
    if (!revision) throw new Error(`Imported revision is missing: ${row.revision_id}`);
    return revision;
  }

  private findPreviousSource(candidate: DomainImportCandidate): PreviousSourceRow | undefined {
    return this.database.prepare(`
      SELECT revisions.item_id
      FROM source_imports AS imports
      JOIN content_revisions AS revisions ON revisions.id = imports.revision_id
      WHERE imports.importer_type = ? AND imports.source_path = ?
      ORDER BY imports.imported_at DESC, imports.rowid DESC
      LIMIT 1
    `).get(candidate.importer, candidate.sourcePath) as PreviousSourceRow | undefined;
  }

  private async prepareStoredMedia(media: ImportedMedia[]): Promise<StoredMediaInput[]> {
    const result: StoredMediaInput[] = [];
    for (const item of media) {
      if (item.kind === 'attachment') continue;
      const storedPath = resolve(item.storedPath);
      const relativePath = relative(this.mediaStoreRoot, storedPath);
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new PathSafetyError(`Stored media escapes the media store: ${item.storedPath}`);
      }
      const info = await stat(storedPath);
      if (!info.isFile()) throw new PathSafetyError(`Stored media is not a file: ${item.storedPath}`);
      if ((await sha256File(storedPath)) !== item.sha256) {
        throw new Error(`Stored media hash mismatch: ${item.storedPath}`);
      }
      result.push({
        sha256: item.sha256,
        relativePath: relativePath.replaceAll('\\', '/'),
        originalName: item.originalName,
        mimeType: mimeTypeFor(item.originalName),
        sizeBytes: info.size,
      });
    }
    return result;
  }

  private ensureMediaAsset(media: StoredMediaInput): string {
    const existing = this.database.prepare('SELECT id FROM media_assets WHERE sha256 = ?').pluck()
      .get(media.sha256) as string | undefined;
    if (existing) return existing;
    const id = this.createId();
    this.database.prepare(`
      INSERT INTO media_assets (
        id, sha256, relative_path, original_name, mime_type, byte_size,
        width, height, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `).run(
      id,
      media.sha256,
      media.relativePath,
      media.originalName,
      media.mimeType,
      media.sizeBytes,
      this.now().toISOString(),
    );
    return id;
  }
}
