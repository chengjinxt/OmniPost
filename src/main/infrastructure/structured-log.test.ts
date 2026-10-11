import { access, mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonLineLogger, pruneExpiredRunArtifacts, redactForLog } from './structured-log.js';

describe('redactForLog', () => {
  it('redacts credentials recursively while preserving useful diagnostics', () => {
    expect(redactForLog({
      platform: 'WECHAT',
      authorization: 'Bearer secret-token',
      nested: {
        appSecret: 'app-secret',
        access_token: 'access-token',
        status: 401,
      },
      url: 'https://example.test/callback?code=oauth-code&state=keep-me',
    })).toEqual({
      platform: 'WECHAT',
      authorization: '[REDACTED]',
      nested: {
        appSecret: '[REDACTED]',
        access_token: '[REDACTED]',
        status: 401,
      },
      url: 'https://example.test/callback?code=%5BREDACTED%5D&state=keep-me',
    });
  });

  it('redacts secrets embedded in free-form errors and URL user information', () => {
    const redacted = redactForLog([
      'request failed: access_token=plain-token client_secret:plain-secret',
      'https://name:password@example.test/path?refresh_token=refresh&state=keep',
    ]);
    expect(JSON.stringify(redacted)).not.toContain('plain-token');
    expect(JSON.stringify(redacted)).not.toContain('plain-secret');
    expect(JSON.stringify(redacted)).not.toContain('password');
    expect(JSON.stringify(redacted)).not.toContain('=refresh');
    expect(redacted).toEqual([
      'request failed: access_token=[REDACTED] client_secret:[REDACTED]',
      'https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/path?refresh_token=%5BREDACTED%5D&state=keep',
    ]);
  });
});

describe('JsonLineLogger', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'omnipost-log-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes one redacted JSON record per line', async () => {
    const logPath = resolve(directory, 'run.jsonl');
    const logger = new JsonLineLogger(logPath, () => new Date('2026-10-12T08:00:00.000Z'));

    await logger.write('info', 'submission prepared', {
      runId: 'run-1',
      cookie: 'session=plaintext',
    });

    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toEqual([{
      timestamp: '2026-10-12T08:00:00.000Z',
      level: 'info',
      message: 'submission prepared',
      data: { runId: 'run-1', cookie: '[REDACTED]' },
    }]);
  });

  it('prunes run directories older than the default 30-day retention', async () => {
    const oldRun = resolve(directory, 'old-run');
    const freshRun = resolve(directory, 'fresh-run');
    await Promise.all([mkdir(oldRun), mkdir(freshRun)]);
    await Promise.all([
      utimes(oldRun, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z')),
      utimes(freshRun, new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z')),
    ]);

    await expect(pruneExpiredRunArtifacts(directory, new Date('2026-10-12T00:00:00.000Z'))).resolves.toBe(1);
    await expect(access(oldRun)).rejects.toThrow();
    await expect(access(freshRun)).resolves.toBeUndefined();
  });
});
