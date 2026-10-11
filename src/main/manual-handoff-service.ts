import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import sanitizeHtml from 'sanitize-html';
import { unified } from 'unified';
import { z } from 'zod';

import type { ContentRevision } from '../domain/index.js';

const ExportRequestSchema = z.object({
  revisionId: z.string().min(1),
  platform: z.literal('MEDIUM'),
  format: z.enum(['MARKDOWN', 'HTML']),
  canonicalUrl: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)).nullable(),
}).strict();

export type ManualHandoffExportRequest = z.input<typeof ExportRequestSchema>;

interface RevisionSource {
  getRevision(id: string): ContentRevision | undefined;
}

interface SaveFileInput {
  suggestedName: string;
  content: string;
  mimeType: string;
}

interface ManualHandoffDependencies {
  revisions: RevisionSource;
  save(input: SaveFileInput): Promise<boolean>;
  openExternal(url: string): Promise<void>;
}

export class ManualHandoffService {
  constructor(private readonly dependencies: ManualHandoffDependencies) {}

  async export(requestValue: ManualHandoffExportRequest): Promise<{
    cancelled: boolean;
    suggestedName: string;
  }> {
    const request = ExportRequestSchema.parse(requestValue);
    const revision = this.dependencies.revisions.getRevision(request.revisionId);
    if (revision === undefined) throw new Error(`Unknown content revision: ${request.revisionId}`);
    const stem = safeFilename(revision.title);
    const suggestedName = `${stem}-medium.${request.format === 'MARKDOWN' ? 'md' : 'html'}`;
    const content = request.format === 'MARKDOWN'
      ? markdownExport(revision, request.canonicalUrl)
      : await htmlExport(revision, request.canonicalUrl);
    const saved = await this.dependencies.save({
      suggestedName,
      content,
      mimeType: request.format === 'MARKDOWN' ? 'text/markdown' : 'text/html',
    });
    return { cancelled: !saved, suggestedName };
  }

  async openEditor(platform: 'MEDIUM'): Promise<void> {
    if (platform !== 'MEDIUM') throw new Error(`Unsupported manual editor: ${platform}`);
    await this.dependencies.openExternal('https://medium.com/new-story');
  }
}

function safeFilename(value: string): string {
  const cleaned = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || '<>:"/\\|?*'.includes(character)
        ? '_'
        : character;
    })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned.slice(0, 100) || 'untitled';
}

function markdownExport(revision: ContentRevision, canonicalUrl: string | null): string {
  const header = [
    '---',
    `title: ${JSON.stringify(revision.title)}`,
    ...(canonicalUrl === null ? [] : [`canonical_url: ${canonicalUrl}`]),
    '---',
  ];
  return `${header.join('\n')}\n\n${revision.bodyMarkdown.trim()}\n`;
}

async function htmlExport(revision: ContentRevision, canonicalUrl: string | null): Promise<string> {
  const rendered = String(await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(revision.bodyMarkdown));
  const safeBody = sanitizeHtml(rendered, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'] },
    allowedSchemes: ['http', 'https'],
  });
  const canonical = canonicalUrl === null ? '' : `\n  <link rel="canonical" href="${escapeAttribute(canonicalUrl)}">`;
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title>${escapeHtml(revision.title)}</title>${canonical}\n</head>\n<body>\n${safeBody}\n</body>\n</html>\n`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
