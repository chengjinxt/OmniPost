import { describe, expect, it } from 'vitest';

import { checkToolchain, parsePnpmVersion } from './check-toolchain.js';

describe('checkToolchain', () => {
  it('accepts the pinned Node minor line and exact pnpm version', () => {
    expect(checkToolchain('v24.21.0', '11.25.0')).toEqual([]);
    expect(checkToolchain('24.21.9', '11.25.0')).toEqual([]);
  });

  it('rejects mismatched Node and pnpm versions', () => {
    expect(checkToolchain('v24.20.1', '11.25.1')).toEqual([
      'Node.js 24.21.x is required; received v24.20.1.',
      'pnpm 11.25.0 is required; received 11.25.1.',
    ]);
  });
});

describe('parsePnpmVersion', () => {
  it('reads pnpm from the package-manager user agent', () => {
    expect(parsePnpmVersion('pnpm/11.25.0 npm/? node/v24.21.0 win32 x64')).toBe('11.25.0');
  });

  it('returns undefined outside a pnpm lifecycle', () => {
    expect(parsePnpmVersion('npm/11.0.0 node/v24.21.0 win32 x64')).toBeUndefined();
  });
});
