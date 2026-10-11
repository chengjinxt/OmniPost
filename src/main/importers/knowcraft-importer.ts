import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { ContentAddressedMediaStore, sha256Bytes, sha256File } from './content-store.js';
import { SourceChangedError } from './markdown-importer.js';
import { parseMarkdown } from './markdown.js';
import { PathSafetyError, resolveSafeExistingPath, resolveSafeRoot } from './safety.js';
import type {
  ContentRevision,
  ImportCandidate,
  ImportPreview,
  ImporterOptions,
  SourceImporter,
} from './types.js';

interface TopicSnapshot {
  sourceRoot: string;
  topicPath: string;
  topicRelativePath: string;
  bodyPaths: string[];
  readmePath: string | null;
  promptsPath: string | null;
  pngPaths: string[];
}

const excludedNames = new Set(['.git', 'backup', 'agents.md']);

function lower(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function naturalPngCompare(left: string, right: string): number {
  const leftName = basename(left);
  const rightName = basename(right);
  const leftPrefix = leftName.match(/^(\d{1,2})[-_]/);
  const rightPrefix = rightName.match(/^(\d{1,2})[-_]/);
  if (leftPrefix && rightPrefix) {
    const difference = Number(leftPrefix[1]) - Number(rightPrefix[1]);
    if (difference !== 0) return difference;
  } else if (leftPrefix) {
    return -1;
  } else if (rightPrefix) {
    return 1;
  }
  return leftName.localeCompare(rightName, 'zh-Hans-CN');
}

function humanizeTopicName(value: string): string {
  const cleaned = value
    .replace(/^\d{8}_\d{1,2}_/, '')
    .replace(/[-_]cards$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) return value;
  return cleaned[0]!.toLocaleUpperCase() + cleaned.slice(1);
}

export class KnowCraftImporter implements SourceImporter {
  private readonly mediaStore: ContentAddressedMediaStore;

  constructor(options: ImporterOptions) {
    this.mediaStore = new ContentAddressedMediaStore(options.mediaStoreRoot);
  }

  async discover(root: string): Promise<ImportCandidate[]> {
    const sourceRoot = await resolveSafeRoot(root);
    const assetsPath = await resolveSafeExistingPath(sourceRoot, join(sourceRoot, 'assets'), 'directory');
    const entries = await readdir(assetsPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    const candidates: ImportCandidate[] = [];
    for (const entry of entries) {
      if (excludedNames.has(lower(entry.name))) continue;
      const path = join(assetsPath, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new PathSafetyError(`Symbolic links and directory junctions are not allowed: ${path}`);
      }
      if (!info.isDirectory()) continue;
      const snapshot = await this.readTopicSnapshot(sourceRoot, path);
      candidates.push(...(await this.candidatesForSnapshot(snapshot)));
    }
    return candidates;
  }

  async preview(candidate: ImportCandidate): Promise<ImportPreview> {
    if (candidate.importer !== 'knowcraft') {
      throw new Error(`Candidate belongs to ${candidate.importer}, not knowcraft.`);
    }
    const topicRelativePath = candidate.context.topicRelativePath;
    if (!topicRelativePath) throw new Error('KnowCraft candidate is missing its topic path.');
    const topicPath = await resolveSafeExistingPath(
      candidate.sourceRoot,
      join(candidate.sourceRoot, topicRelativePath),
      'directory',
    );
    const snapshot = await this.readTopicSnapshot(candidate.sourceRoot, topicPath);
    const currentCandidates = await this.candidatesForSnapshot(snapshot);
    const current = currentCandidates.find((item) => item.relativePath === candidate.relativePath);
    if (!current || current.sourceHash !== candidate.sourceHash) {
      throw new SourceChangedError(candidate.sourcePath);
    }

    let title = candidate.titleHint;
    let bodyMarkdown = '';
    let frontmatter: Record<string, unknown> = {};
    if (current.context.bodyRelativePath) {
      const bodyPath = await resolveSafeExistingPath(
        current.sourceRoot,
        join(current.sourceRoot, current.context.bodyRelativePath),
        'file',
      );
      const parsed = parseMarkdown(await readFile(bodyPath), bodyPath);
      title = parsed.title;
      bodyMarkdown = parsed.bodyMarkdown;
      frontmatter = parsed.frontmatter;
    }

    let promptsMarkdown: string | null = null;
    if (current.context.promptsRelativePath) {
      const promptsPath = await resolveSafeExistingPath(
        current.sourceRoot,
        join(current.sourceRoot, current.context.promptsRelativePath),
        'file',
      );
      promptsMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(promptsPath));
    }

    const media: ImportPreview['media'] = [];
    for (const relativePath of current.context.mediaRelativePaths) {
      const sourcePath = await resolveSafeExistingPath(
        current.sourceRoot,
        join(current.sourceRoot, relativePath),
        'file',
      );
      media.push({
        kind: 'image',
        order: media.length,
        sourcePath,
        originalName: basename(sourcePath),
      });
    }

    return {
      candidate: current,
      kind: current.kind,
      title,
      bodyMarkdown,
      frontmatter,
      media,
      metadata: {
        topicRelativePath: current.context.topicRelativePath,
        bodyRelativePath: current.context.bodyRelativePath,
        promptsMarkdown,
      },
      warnings: [],
    };
  }

  async ingest(candidate: ImportCandidate): Promise<ContentRevision> {
    const preview = await this.preview(candidate);
    const media: ContentRevision['media'] = [];
    for (const item of preview.media) {
      const stored = await this.mediaStore.put(candidate.sourceRoot, item.sourcePath);
      media.push({ ...item, ...stored });
    }
    return {
      sourceHash: preview.candidate.sourceHash,
      sourcePath: preview.candidate.sourcePath,
      importer: 'knowcraft',
      kind: preview.kind,
      title: preview.title,
      bodyMarkdown: preview.bodyMarkdown,
      metadata: preview.metadata,
      media,
      warnings: preview.warnings,
    };
  }

  private async readTopicSnapshot(sourceRoot: string, topicPath: string): Promise<TopicSnapshot> {
    const safeTopic = await resolveSafeExistingPath(sourceRoot, topicPath, 'directory');
    const entries = await readdir(safeTopic, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    const bodyPaths: string[] = [];
    const pngPaths: string[] = [];
    let readmePath: string | null = null;
    let promptsPath: string | null = null;

    for (const entry of entries) {
      if (excludedNames.has(lower(entry.name))) continue;
      const path = join(safeTopic, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new PathSafetyError(`Symbolic links and directory junctions are not allowed: ${path}`);
      }
      if (!info.isFile()) continue;
      const name = lower(entry.name);
      if (name === 'prompts.md') {
        promptsPath ??= path;
      } else if (name === 'readme.md') {
        readmePath ??= path;
      } else if (name.endsWith('.md')) {
        bodyPaths.push(path);
      } else if (name.endsWith('.png')) {
        pngPaths.push(path);
      }
    }
    bodyPaths.sort((left, right) => basename(left).localeCompare(basename(right), 'en-US'));
    pngPaths.sort(naturalPngCompare);
    return {
      sourceRoot,
      topicPath: safeTopic,
      topicRelativePath: relative(sourceRoot, safeTopic).replaceAll('\\', '/'),
      bodyPaths,
      readmePath,
      promptsPath,
      pngPaths,
    };
  }

  private async candidatesForSnapshot(snapshot: TopicSnapshot): Promise<ImportCandidate[]> {
    const selectedBodies =
      snapshot.bodyPaths.length > 0
        ? snapshot.bodyPaths
        : snapshot.readmePath
          ? [snapshot.readmePath]
          : snapshot.pngPaths.length > 0
            ? [null]
            : [];
    const promptsHash = snapshot.promptsPath ? await sha256File(snapshot.promptsPath) : null;
    const mediaHashes = await Promise.all(
      snapshot.pngPaths.map(async (path) => [
        relative(snapshot.sourceRoot, path).replaceAll('\\', '/'),
        await sha256File(path),
      ]),
    );
    const candidates: ImportCandidate[] = [];
    for (const bodyPath of selectedBodies) {
      const bodyRelativePath = bodyPath
        ? relative(snapshot.sourceRoot, bodyPath).replaceAll('\\', '/')
        : null;
      const documentHash = bodyPath ? await sha256File(bodyPath) : sha256Bytes(JSON.stringify(mediaHashes));
      const sourceHash = sha256Bytes(
        JSON.stringify({
          importer: 'knowcraft',
          topic: snapshot.topicRelativePath,
          body: bodyRelativePath,
          documentHash,
          promptsHash,
          mediaHashes,
        }),
      );
      const titleHint = bodyPath
        ? parseMarkdown(await readFile(bodyPath), bodyPath).title
        : humanizeTopicName(basename(snapshot.topicPath));
      const relativePath = bodyRelativePath ?? `${snapshot.topicRelativePath}/#media-only`;
      candidates.push({
        id: `knowcraft:${sourceHash}`,
        importer: 'knowcraft',
        kind: bodyPath ? 'document' : 'media-only',
        sourceRoot: snapshot.sourceRoot,
        sourcePath: bodyPath ?? snapshot.topicPath,
        relativePath,
        titleHint,
        sourceHash,
        documentHash,
        context: {
          bodyRelativePath,
          topicRelativePath: snapshot.topicRelativePath,
          promptsRelativePath: snapshot.promptsPath
            ? relative(snapshot.sourceRoot, snapshot.promptsPath).replaceAll('\\', '/')
            : null,
          mediaRelativePaths: snapshot.pngPaths.map((path) =>
            relative(snapshot.sourceRoot, path).replaceAll('\\', '/'),
          ),
        },
      });
    }
    return candidates;
  }
}
