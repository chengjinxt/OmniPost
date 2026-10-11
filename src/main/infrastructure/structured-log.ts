import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const sensitiveKey = /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
const sensitiveQueryParameter = /^(access[_-]?token|refresh[_-]?token|code|client[_-]?secret|api[-_]?key|password)$/i;
const inlineSecret = /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[-_]?key|password|cookie)\s*([=:])\s*[^\s,;&]+/gi;

function redactString(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username.length > 0) {
      url.username = '[REDACTED]';
      changed = true;
    }
    if (url.password.length > 0) {
      url.password = '[REDACTED]';
      changed = true;
    }
    for (const name of [...url.searchParams.keys()]) {
      if (sensitiveQueryParameter.test(name)) {
        url.searchParams.set(name, '[REDACTED]');
        changed = true;
      }
    }
    if (changed) {
      return url.toString();
    }
  } catch {
    // Diagnostic strings do not need to be URLs.
  }

  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(inlineSecret, (_match, name: string, separator: string) => (
      `${name}${separator}[REDACTED]`
    ));
}

export function redactForLog(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactForLog(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

export async function pruneExpiredRunArtifacts(
  artifactRoot: string,
  now = new Date(),
  retentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error('Artifact retention must be a positive number of days.');
  }

  const root = resolve(artifactRoot);
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const target = resolve(root, entry.name);
    const targetRelativePath = relative(root, target);
    if (targetRelativePath.startsWith('..') || isAbsolute(targetRelativePath)) {
      throw new Error('Refusing to prune outside the run-artifact root.');
    }

    if ((await stat(target)).mtimeMs < cutoff) {
      await rm(target, { recursive: true, force: true });
      removed += 1;
    }
  }

  return removed;
}

export class JsonLineLogger {
  public constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(level: LogLevel, message: string, data: unknown = {}): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const record = {
      timestamp: this.now().toISOString(),
      level,
      message,
      data: redactForLog(data),
    };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
