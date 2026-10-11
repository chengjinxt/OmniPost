import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from 'playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const projectRoot = resolve('.');
const packagedExecutable = process.env.OMNIPOST_E2E_EXECUTABLE;
const expectedApiKeys = [
  'approvePublishPlan',
  'createContent',
  'createPublishPlan',
  'discoverImports',
  'exportDiagnosticLog',
  'exportManualHandoff',
  'generateAiVariant',
  'getAiProfile',
  'getAutoStart',
  'getDiagnostics',
  'getMetadata',
  'ingestImport',
  'listAccounts',
  'listContent',
  'listPublishJobs',
  'openManualEditor',
  'openRunArtifacts',
  'previewImport',
  'reviseContent',
  'saveAccount',
  'saveAiProfile',
  'setAutoStart',
];

test('starts OmniPost with an isolated renderer and its whitelisted bridge', async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), 'omnipost-electron-e2e-'));
  const userDataArgument = `--user-data-dir=${userDataDirectory}`;
  const launchOptions = packagedExecutable === undefined
    ? {
        args: [projectRoot, userDataArgument],
        cwd: projectRoot,
        env: electronEnvironment(),
        timeout: 30_000,
      }
    : {
        args: [userDataArgument],
        cwd: projectRoot,
        env: electronEnvironment(),
        executablePath: resolve(packagedExecutable),
        timeout: 30_000,
      };

  let application: ElectronApplication | undefined;

  try {
    application = await electron.launch(launchOptions);
    const page = await application.firstWindow();
    const rendererErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text());
        console.error(`[renderer console] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      rendererErrors.push(error.message);
      console.error(`[renderer error] ${error.message}`);
    });
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveTitle('OmniPost');
    await expect(page.getByRole('heading', { name: '内容工作台', level: 1 })).toBeVisible();

    const rendererSecurity = await page.evaluate(async () => {
      const rendererGlobal = globalThis as unknown as {
        process?: unknown;
        require?: unknown;
        omniPost?: {
          getMetadata(): Promise<unknown>;
        } & Record<string, unknown>;
      };

      return {
        hasNodeProcess: typeof rendererGlobal.process !== 'undefined',
        hasRequire: typeof rendererGlobal.require !== 'undefined',
        apiKeys: Object.keys(rendererGlobal.omniPost ?? {}).sort(),
        metadata: await rendererGlobal.omniPost?.getMetadata(),
      };
    });

    expect(rendererSecurity.hasNodeProcess).toBe(false);
    expect(rendererSecurity.hasRequire).toBe(false);
    expect(rendererSecurity.apiKeys).toEqual(expectedApiKeys);
    expect(rendererSecurity.metadata).toMatchObject({
      name: 'OmniPost',
      defaultLocale: 'zh-CN',
      defaultTimeZone: 'Asia/Shanghai',
    });

    const trustedRendererUrl = page.url();
    const initialWindowCount = application.windows().length;
    await page.evaluate(() => {
      window.open('https://example.com/omnipost-window-probe', '_blank');
    });
    await delay(250);
    expect(application.windows()).toHaveLength(initialWindowCount);

    await page.evaluate(() => {
      window.location.href = 'https://example.com/omnipost-navigation-probe';
    });
    await delay(250);
    const securedWindows = await application.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().map((window) => window.webContents.getURL())
    ));
    expect(securedWindows).toEqual([trustedRendererUrl]);

    const applicationState = await application.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
    }));
    expect(applicationState.isPackaged).toBe(packagedExecutable !== undefined);
    expect(rendererErrors).toEqual([]);
  } finally {
    await application?.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function electronEnvironment(): Record<string, string> {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  return {
    ...inheritedEnvironment,
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_ENV: 'test',
  };
}
