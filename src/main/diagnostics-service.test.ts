import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DiagnosticsService } from './diagnostics-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    const resolved = resolve(root);
    if (!resolved.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove ${resolved}`);
    await rm(resolved, { force: true, recursive: true });
  }));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omnipost-diagnostics-'));
  temporaryRoots.push(root);
  return root;
}

describe('DiagnosticsService', () => {
  it('summarizes an absent log and artifact directory without creating them', async () => {
    const root = await makeRoot();
    const service = new DiagnosticsService({
      logPath: join(root, 'logs', 'omnipost.jsonl'),
      artifactRoot: join(root, 'run-artifacts'),
      saveLog: async () => true,
      openPath: async () => '',
    });

    await expect(service.getSummary()).resolves.toEqual({
      retentionDays: 30,
      logBytes: 0,
      artifactCount: 0,
      latestArtifactAt: null,
    });
  });

  it('counts regular run artifacts and reports the latest modification time', async () => {
    const root = await makeRoot();
    const artifactRoot = join(root, 'run-artifacts');
    await mkdir(join(artifactRoot, 'run-1', 'youtube'), { recursive: true });
    await writeFile(join(artifactRoot, 'run-1', 'youtube', 'trace.zip'), 'trace');
    await writeFile(join(artifactRoot, 'run-1', 'screenshot.png'), 'image');
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'omnipost.jsonl'), '123456');
    const service = new DiagnosticsService({
      logPath: join(root, 'logs', 'omnipost.jsonl'),
      artifactRoot,
      saveLog: async () => true,
      openPath: async () => '',
    });

    const summary = await service.getSummary();
    expect(summary.logBytes).toBe(6);
    expect(summary.artifactCount).toBe(2);
    expect(summary.latestArtifactAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates an empty redacted log when needed and delegates export', async () => {
    const root = await makeRoot();
    const exports: Array<{ suggestedName: string; sourcePath: string }> = [];
    const logPath = join(root, 'logs', 'omnipost.jsonl');
    const service = new DiagnosticsService({
      logPath,
      artifactRoot: join(root, 'run-artifacts'),
      saveLog: async (input) => {
        exports.push(input);
        return true;
      },
      openPath: async () => '',
    });

    await expect(service.exportLog()).resolves.toEqual({
      cancelled: false,
      fileName: 'omnipost-diagnostics.jsonl',
    });
    expect(exports).toEqual([{ suggestedName: 'omnipost-diagnostics.jsonl', sourcePath: logPath }]);
    await expect(service.getSummary()).resolves.toMatchObject({ logBytes: 0 });
  });

  it('creates and opens the run artifact directory and surfaces shell failures', async () => {
    const root = await makeRoot();
    const opened: string[] = [];
    const artifactRoot = join(root, 'run-artifacts');
    const service = new DiagnosticsService({
      logPath: join(root, 'logs', 'omnipost.jsonl'),
      artifactRoot,
      saveLog: async () => true,
      openPath: async (path) => {
        opened.push(path);
        return '';
      },
    });

    await expect(service.openArtifacts()).resolves.toBeUndefined();
    expect(opened).toEqual([artifactRoot]);

    const failing = new DiagnosticsService({
      logPath: join(root, 'logs', 'omnipost.jsonl'),
      artifactRoot,
      saveLog: async () => true,
      openPath: async () => 'No application is associated with the path',
    });
    await expect(failing.openArtifacts()).rejects.toThrow('No application is associated');
  });
});
