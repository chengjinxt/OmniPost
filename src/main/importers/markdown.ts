import { basename, extname } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { ImportedMediaKind } from './types.js';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
  title: string;
}

export interface MarkdownMediaReference {
  kind: ImportedMediaKind;
  target: string;
  order: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function splitFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = normalizeLineEndings(markdown);
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { frontmatter: {}, body: normalized };
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex < 0) return { frontmatter: {}, body: normalized };
  const yaml = lines.slice(1, closingIndex).join('\n');
  return {
    frontmatter: recordValue(parseYaml(yaml, { maxAliasCount: 20 })),
    body: lines.slice(closingIndex + 1).join('\n').replace(/^\n+/, ''),
  };
}

function firstHeading(body: string): { index: number; title: string } | null {
  const lines = body.split('\n');
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '';
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading?.[1]) return { index, title: heading[1].trim() };
  }
  return null;
}

function withoutFirstHeading(body: string, headingIndex: number | null): string {
  if (headingIndex === null) return body.trim();
  const lines = body.split('\n');
  lines.splice(headingIndex, 1);
  while (lines[headingIndex] === '') lines.splice(headingIndex, 1);
  return lines.join('\n').trim();
}

export function filenameTitle(path: string): string {
  const name = basename(path);
  return name.slice(0, name.length - extname(name).length).trim();
}

export function parseMarkdown(
  bytes: Uint8Array,
  path: string,
  options: { fallbackTitle?: (path: string) => string; stripTelegramBlock?: boolean } = {},
): ParsedMarkdown {
  const { frontmatter, body: rawBody } = splitFrontmatter(decodeUtf8(bytes));
  const body = options.stripTelegramBlock
    ? rawBody.replace(
        /<!--\s*TELEGRAM_MESSAGE_BEGIN\s*-->[\s\S]*?<!--\s*TELEGRAM_MESSAGE_END\s*-->/gi,
        '',
      )
    : rawBody;
  const heading = firstHeading(body);
  const frontmatterTitle =
    typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : null;
  const title = frontmatterTitle ?? heading?.title ?? options.fallbackTitle?.(path) ?? filenameTitle(path);
  return {
    frontmatter,
    bodyMarkdown: withoutFirstHeading(body, heading?.index ?? null),
    title,
  };
}

interface MarkdownToken {
  label: string;
  target: string;
  start: number;
}

function findClosingSquareBracket(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === ']') return index;
  }
  return -1;
}

function markdownTokenAt(line: string, start: number, image: boolean): MarkdownToken | null {
  const labelStart = start + (image ? 2 : 1);
  const labelEnd = findClosingSquareBracket(line, labelStart);
  if (labelEnd < 0 || line[labelEnd + 1] !== '(') return null;
  let depth = 1;
  for (let index = labelEnd + 2; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0) {
      return {
        label: line.slice(labelStart, labelEnd),
        target: normalizeMarkdownTarget(line.slice(labelEnd + 2, index)),
        start,
      };
    }
  }
  return null;
}

function imageTokens(line: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf('![', cursor);
    if (start < 0) break;
    const token = markdownTokenAt(line, start, true);
    if (token) tokens.push(token);
    cursor = start + 2;
  }
  return tokens;
}

function prefixedLinkToken(
  line: string,
): { kind: 'video' | 'attachment'; token: MarkdownToken } | null {
  const match = line.match(/^\s*(视频|附件)\s*[：:]\s*/);
  if (!match) return null;
  const start = line.indexOf('[', match[0].length);
  if (start < 0) return null;
  const token = markdownTokenAt(line, start, false);
  if (!token) return null;
  return { kind: match[1] === '视频' ? 'video' : 'attachment', token };
}

export function normalizeMarkdownTarget(target: string): string {
  let value = target.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\ ', ' ');
}

export function isExternalMediaTarget(target: string): boolean {
  return /^(?:https?:|data:|file:|#|\/\/)/i.test(target);
}

export function extractMarkdownMedia(markdown: string): MarkdownMediaReference[] {
  const references: Array<MarkdownMediaReference & { position: number }> = [];
  const lines = normalizeLineEndings(markdown).split('\n');
  let fencedBy: string | null = null;
  let sequence = 0;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? '';
      fencedBy = fencedBy === null ? marker : fencedBy === marker ? null : fencedBy;
      continue;
    }
    if (fencedBy !== null) continue;

    for (const token of imageTokens(line)) {
      references.push({ kind: 'image', target: token.target, order: sequence, position: token.start });
      sequence += 1;
    }
    const link = prefixedLinkToken(line);
    if (link) {
      references.push({
        kind: link.kind,
        target: link.token.target,
        order: sequence,
        position: link.token.start,
      });
      sequence += 1;
    }
    const videoPattern = /<video\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
    for (const match of line.matchAll(videoPattern)) {
      const target = normalizeMarkdownTarget(match[1] ?? match[2] ?? match[3] ?? '');
      references.push({
        kind: 'video',
        target,
        order: sequence,
        position: match.index ?? Number.MAX_SAFE_INTEGER,
      });
      sequence += 1;
    }
  }
  references.sort((left, right) => left.order - right.order || left.position - right.position);
  return references.map(({ kind, target, order }) => ({ kind, target, order }));
}
