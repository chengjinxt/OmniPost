import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_ARTIFACT_RETENTION_DAYS } from './infrastructure/structured-log.js';

export interface DiagnosticsSummary {
  retentionDays: number;
  logBytes: number;
  artifactCount: number;
  latestArtifactAt: string | null;
}

interface DiagnosticsServiceOptions {
  logPath: string;
  artifactRoot: string;
  saveLog(input: { suggestedName: string; sourcePath: string }): Promise<boolean>;
  openPath(path: string): Promise<string>;
}

interface ArtifactStats {
  count: number;
  latestMtimeMs: number | null;
}

export class DiagnosticsService {
  public constructor(private readonly options: DiagnosticsServiceOptions) {}

  public async getSummary(): Promise<DiagnosticsSummary> {
    const [logBytes, artifacts] = await Promise.all([
      regularFileSize(this.options.logPath),
      scanRegularFiles(this.options.artifactRoot),
    ]);
    return {
      retentionDays: DEFAULT_ARTIFACT_RETENTION_DAYS,
      logBytes,
      artifactCount: artifacts.count,
      latestArtifactAt: artifacts.latestMtimeMs === null
        ? null
        : new Date(artifacts.latestMtimeMs).toISOString(),
    };
  }

  public async exportLog(): Promise<{ cancelled: boolean; fileName: string }> {
    const fileName = 'omnipost-diagnostics.jsonl';
    await mkdir(dirname(this.options.logPath), { recursive: true });
    await writeFile(this.options.logPath, '', { encoding: 'utf8', flag: 'a' });
    const saved = await this.options.saveLog({
      suggestedName: fileName,
      sourcePath: this.options.logPath,
    });
    return { cancelled: !saved, fileName };
  }

  public async openArtifacts(): Promise<void> {
    await mkdir(this.options.artifactRoot, { recursive: true });
    const error = await this.options.openPath(this.options.artifactRoot);
    if (error.length > 0) throw new Error(error);
  }
}

async function regularFileSize(path: string): Promise<number> {
  try {
    const information = await stat(path);
    return information.isFile() ? information.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function scanRegularFiles(root: string): Promise<ArtifactStats> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { count: 0, latestMtimeMs: null };
    }
    throw error;
  }

  let count = 0;
  let latestMtimeMs: number | null = null;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanRegularFiles(path);
      count += nested.count;
      if (nested.latestMtimeMs !== null) {
        latestMtimeMs = latestMtimeMs === null
          ? nested.latestMtimeMs
          : Math.max(latestMtimeMs, nested.latestMtimeMs);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const information = await stat(path);
    count += 1;
    latestMtimeMs = latestMtimeMs === null
      ? information.mtimeMs
      : Math.max(latestMtimeMs, information.mtimeMs);
  }
  return { count, latestMtimeMs };
}
