import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveBrowserProfilePath, resolveRunArtifactPath } from './runtime-paths.js';

describe('runtime paths', () => {
  const applicationData = resolve('C:/Users/creator/AppData/Roaming/OmniPost');

  it('isolates every platform account in its own browser profile', () => {
    expect(resolveBrowserProfilePath(applicationData, 'YOUTUBE', 'account-123')).toBe(
      resolve(applicationData, 'browser-profiles', 'youtube', 'account-123'),
    );
  });

  it('stores run diagnostics under run/platform/account/job', () => {
    expect(resolveRunArtifactPath(applicationData, {
      runId: 'run-1',
      platform: 'WECHAT',
      accountId: 'account-1',
      jobId: 'job-1',
    })).toBe(resolve(
      applicationData,
      'run-artifacts',
      'run-1',
      'wechat',
      'account-1',
      'job-1',
    ));
  });

  it.each(['../escape', 'nested/path', 'nested\\path', '', '.', '..'])('rejects unsafe path segment %s', (segment) => {
    expect(() => resolveBrowserProfilePath(applicationData, 'YOUTUBE', segment)).toThrow(/safe identifier/);
  });
});
