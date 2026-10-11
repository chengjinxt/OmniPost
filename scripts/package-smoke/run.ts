import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  assertSafeTemporaryInstallLayout,
  buildNsisInstallArguments,
} from './install-layout.ts';

type PackageManifest = {
  version?: string;
  build?: {
    productName?: string;
  };
};

const projectRoot = resolve('.');
const releaseDirectory = resolve(projectRoot, 'release');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const packageManifest = JSON.parse(
  readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
) as PackageManifest;
const productName = packageManifest.build?.productName ?? 'OmniPost';
const packageVersion = packageManifest.version ?? '0.0.0';

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}

function run(): void {
  const requestedTarget = process.argv[2];
  if (requestedTarget === '--validate-install-layout') {
    const temporaryBase = process.argv[3];
    const temporaryRoot = process.argv[4];
    const installDirectory = process.argv[5];
    if (
      temporaryBase === undefined
      || temporaryRoot === undefined
      || installDirectory === undefined
    ) {
      throw new Error(
        '--validate-install-layout requires a temporary base, temporary root, and install directory.',
      );
    }
    assertSafeTemporaryInstallLayout(
      temporaryBase,
      temporaryRoot,
      installDirectory,
    );
    console.log(JSON.stringify(buildNsisInstallArguments(installDirectory)));
    return;
  }

  if (requestedTarget === '--unpacked') {
    runPackagedExecutableSmoke(
      resolve(process.argv[3] ?? join(releaseDirectory, 'win-unpacked', `${productName}.exe`)),
    );
    return;
  }

  const installerPath = resolve(
    requestedTarget
      ?? join(releaseDirectory, `${productName}-${packageVersion}-x64-setup.exe`),
  );
  if (existsSync(installerPath) && basename(installerPath).toLowerCase().endsWith('-setup.exe')) {
    runInstalledApplicationSmoke(installerPath);
    return;
  }

  if (requestedTarget !== undefined) {
    runPackagedExecutableSmoke(installerPath);
    return;
  }

  const unpackedExecutable = resolve(
    releaseDirectory,
    'win-unpacked',
    `${productName}.exe`,
  );
  if (existsSync(unpackedExecutable)) {
    console.warn(
      `NSIS installer was not found at ${installerPath}; smoke-testing the unpacked application instead.`,
    );
    runPackagedExecutableSmoke(unpackedExecutable);
    return;
  }

  throw new Error(
    `Neither the NSIS installer nor unpacked OmniPost executable was found under ${releaseDirectory}.`,
  );
}

function runInstalledApplicationSmoke(installerPath: string): void {
  assertNoExistingInstallation();

  const temporaryBase = realpathSync.native(tmpdir());
  const temporaryRoot = mkdtempSync(join(temporaryBase, 'omnipost-install-smoke-'));
  const installDirectory = join(temporaryRoot, 'installed');
  mkdirSync(installDirectory);
  assertSafeTemporaryInstallLayout(temporaryBase, temporaryRoot, installDirectory);

  const installedExecutable = resolve(installDirectory, `${productName}.exe`);
  const uninstaller = resolve(installDirectory, `Uninstall ${productName}.exe`);
  let primaryError: unknown;

  try {
    console.log(`Installing ${basename(installerPath)} into ${installDirectory}`);
    runChecked(installerPath, buildNsisInstallArguments(installDirectory), {
      timeout: 300_000,
    });
    waitFor(
      () => existsSync(installedExecutable),
      60_000,
      `Installed executable was not created: ${installedExecutable}`,
    );
    runPackagedExecutableSmoke(installedExecutable);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (existsSync(uninstaller)) {
      console.log(`Uninstalling the temporary OmniPost installation from ${installDirectory}`);
      runChecked(uninstaller, ['/S'], { timeout: 300_000 });
      waitFor(
        () => !existsSync(installedExecutable),
        60_000,
        `Installed executable remains after uninstall: ${installedExecutable}`,
      );
    } else if (existsSync(installedExecutable)) {
      throw new Error(`The temporary installation has no uninstaller: ${uninstaller}`);
    }

    assertNoExistingInstallation();
  } catch (error) {
    cleanupError = error;
  }

  try {
    assertSafeTemporaryInstallLayout(temporaryBase, temporaryRoot, installDirectory);
    removeTemporaryRoot(temporaryRoot);
  } catch (error) {
    cleanupError ??= error;
  }

  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      console.error('Temporary installation cleanup also failed:');
      console.error(cleanupError);
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}

function runPackagedExecutableSmoke(executablePath: string): void {
  if (!existsSync(executablePath)) {
    throw new Error(
      `Packaged OmniPost executable was not found: ${executablePath}`,
    );
  }

  const packagedResources = resolve(executablePath, '..', 'resources');
  const unpackedModules = resolve(
    packagedResources,
    'app.asar.unpacked',
    'node_modules',
  );
  const ffmpegPath = resolve(unpackedModules, 'ffmpeg-static', 'ffmpeg.exe');
  const ffprobePath = resolve(
    unpackedModules,
    'ffprobe-static',
    'bin',
    'win32',
    'x64',
    'ffprobe.exe',
  );
  const requiredRuntimeFiles = [
    resolve(packagedResources, 'app.asar'),
    resolve(packagedResources, 'runtime', 'browser-runtime.json'),
    resolve(unpackedModules, 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
    resolve(
      unpackedModules,
      '@img',
      'sharp-win32-x64',
      'lib',
      'sharp-win32-x64-0.35.5.node',
    ),
    resolve(
      unpackedModules,
      '@img',
      'sharp-win32-x64',
      'lib',
      'libvips-42.dll',
    ),
    ffmpegPath,
    ffprobePath,
  ];
  const missingRuntimeFiles = requiredRuntimeFiles.filter((path) => !existsSync(path));
  if (missingRuntimeFiles.length > 0) {
    throw new Error(
      `Packaged runtime files are missing:\n${missingRuntimeFiles.map((path) => `- ${path}`).join('\n')}`,
    );
  }

  for (const binaryPath of [ffmpegPath, ffprobePath]) {
    runChecked(binaryPath, ['-version']);
  }

  const playwrightCli = resolve(projectRoot, 'node_modules', 'playwright', 'cli.js');
  runChecked(
    process.execPath,
    [playwrightCli, 'test', '--config=tests/e2e/playwright.config.ts'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        OMNIPOST_E2E_EXECUTABLE: executablePath,
      },
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
}

function assertNoExistingInstallation(): void {
  const uninstallRoots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const escapedProductName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactDisplayName = new RegExp(
    `^\\s*DisplayName\\s+REG_SZ\\s+${escapedProductName}\\s*$`,
    'im',
  );
  const matchingRoots: string[] = [];

  for (const uninstallRoot of uninstallRoots) {
    const result = spawnSync(
      'reg.exe',
      ['query', uninstallRoot, '/s', '/f', productName, '/d'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(
        `Unable to inspect installed applications under ${uninstallRoot}:\n${result.stderr}`,
      );
    }
    if (result.status === 0 && exactDisplayName.test(result.stdout)) {
      matchingRoots.push(uninstallRoot);
    }
  }

  if (matchingRoots.length > 0) {
    throw new Error(
      `Refusing to run the installer smoke test while ${productName} is already registered under:\n`
      + matchingRoots.map((root) => `- ${root}`).join('\n'),
    );
  }
}

function runChecked(
  command: string,
  arguments_: string[],
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
): void {
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${String(result.status)}.\n`
      + `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds: number,
  timeoutMessage: string,
): void {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    Atomics.wait(waitBuffer, 0, 0, 200);
  }
  throw new Error(timeoutMessage);
}

function removeTemporaryRoot(temporaryRoot: string): void {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (!existsSync(temporaryRoot)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    Atomics.wait(waitBuffer, 0, 0, 200);
  }
  throw lastError ?? new Error(`Unable to remove temporary root: ${temporaryRoot}`);
}
