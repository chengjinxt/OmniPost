import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  build?: {
    asar?: boolean;
    npmRebuild?: boolean;
    asarUnpack?: string[];
    files?: string[];
    extraResources?: Array<{ from: string; to: string }>;
    win?: { requestedExecutionLevel?: string };
    nsis?: Record<string, unknown>;
  };
};

const manifest = JSON.parse(
  readFileSync(resolve('package.json'), 'utf8'),
) as PackageManifest;

describe('release packaging configuration', () => {
  it('keeps release and E2E scripts behind the pinned toolchain gate', () => {
    expect(manifest.packageManager).toBe('pnpm@11.25.0');
    expect(manifest.engines).toMatchObject({
      node: '>=24.21.0 <24.22.0',
      pnpm: '11.25.0',
    });

    for (const scriptName of [
      'test:e2e',
      'test:browser:e2e',
      'package:dir',
      'package',
      'package:smoke',
    ]) {
      expect(manifest.scripts?.[scriptName]).toContain('scripts/check-toolchain.ts');
    }
    expect(manifest.scripts?.['test:browser:e2e']).toContain('OMNIPOST_BROWSER_E2E=1');
    expect(manifest.scripts?.['test:browser:e2e']).toContain(
      'src/main/browser/assisted-browser-engine.test.ts',
    );
    expect(manifest.scripts?.package).toContain('scripts/package-smoke/run.ts');
  });

  it('builds silent NSIS arguments and rejects cleanup paths outside its temporary root', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'omnipost-install-smoke-'));
    const installDirectory = join(temporaryRoot, 'installed');
    mkdirSync(installDirectory);

    try {
      const accepted = validateInstallLayout(
        tmpdir(),
        temporaryRoot,
        installDirectory,
      );
      expect(accepted.status).toBe(0);
      expect(accepted.stdout.trim()).toBe(
        JSON.stringify(['/S', `/D=${resolve(installDirectory)}`]),
      );

      const unsafeRoot = validateInstallLayout(
        tmpdir(),
        tmpdir(),
        installDirectory,
      );
      expect(unsafeRoot.status).toBe(1);
      expect(unsafeRoot.stderr).toMatch(/temporary root/i);

      const unsafeInstallDirectory = validateInstallLayout(
        tmpdir(),
        temporaryRoot,
        tmpdir(),
      );
      expect(unsafeInstallDirectory.status).toBe(1);
      expect(unsafeInstallDirectory.stderr).toMatch(/install directory/i);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('uses an asar archive while unpacking every required native runtime', () => {
    expect(manifest.build?.asar).toBe(true);
    expect(manifest.build?.npmRebuild).toBe(false);
    expect(manifest.build?.files).toEqual(expect.arrayContaining([
      'out/**/*',
      'resources/**/*',
      'package.json',
    ]));

    const unpack = manifest.build?.asarUnpack ?? [];
    for (const runtime of [
      'better-sqlite3',
      'sharp',
      '@img',
      'ffmpeg-static',
      'ffprobe-static',
      'playwright-core',
    ]) {
      expect(unpack.some((pattern) => pattern.includes(runtime))).toBe(true);
    }
  });

  it('declares the assisted-browser dependency on system Microsoft Edge', () => {
    const runtimeManifestPath = resolve('resources/runtime/browser-runtime.json');
    expect(existsSync(runtimeManifestPath)).toBe(true);
    expect(manifest.build?.extraResources).toContainEqual({
      from: 'resources/runtime/browser-runtime.json',
      to: 'runtime/browser-runtime.json',
    });

    const runtimeManifest = JSON.parse(
      readFileSync(runtimeManifestPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(runtimeManifest).toMatchObject({
      automation: 'playwright',
      browserProvisioning: 'system',
      browserChannel: 'msedge',
      bundledChromium: false,
      missingBrowserFallback: 'MANUAL_HANDOFF',
    });
  });

  it('builds a least-privilege, assisted NSIS installer', () => {
    expect(manifest.build?.win?.requestedExecutionLevel).toBe('asInvoker');
    expect(manifest.build?.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
    });
  });
});

function validateInstallLayout(
  temporaryBase: string,
  temporaryRoot: string,
  installDirectory: string,
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      resolve('scripts/package-smoke/run.ts'),
      '--validate-install-layout',
      temporaryBase,
      temporaryRoot,
      installDirectory,
    ],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}
