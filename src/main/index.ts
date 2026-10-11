import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ContentRepository } from './infrastructure/content-repository.js';
import { AccountRepository } from './infrastructure/account-repository.js';
import { openDatabase } from './infrastructure/database.js';
import { electronEncryptionProvider } from './infrastructure/electron-encryption-provider.js';
import { PublicationRepository } from './infrastructure/publication-repository.js';
import { SecretVault } from './infrastructure/secret-vault.js';
import {
  GenericMarkdownImporter,
  KnowCraftImporter,
  PersistentSourceImporterAdapter,
  TgExporterImporter,
} from './importers/index.js';
import { ImportService, type ImporterChoice } from './import-service.js';
import { registerApplicationIpc } from './ipc-handlers.js';
import { PublishingService } from './publishing-service.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { createTrayMenuTemplate } from './tray-menu.js';
import { createMainWindowOptions } from './window-config.js';
import { AiProfileRepository, AiVariantService, FetchAiTransport } from './ai/index.js';
import { AssistedBrowserEngine } from './browser/index.js';
import { JsonLineLogger, pruneExpiredRunArtifacts } from './infrastructure/structured-log.js';
import { createPublishingRuntime, type PublishingRuntime } from './runtime/scheduler-runtime.js';
import { ManualHandoffService } from './manual-handoff-service.js';
import { DiagnosticsService } from './diagnostics-service.js';
import { createTrustedIpcRegistrar } from './trusted-ipc.js';
import { installWindowSecurity, isAllowedDevelopmentRendererUrl } from './window-security.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let publishingRuntime: PublishingRuntime | null = null;
let assistedBrowser: AssistedBrowserEngine | null = null;
let isQuitting = false;

function rendererUrl(): string {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && developmentUrl !== undefined && isAllowedDevelopmentRendererUrl(developmentUrl)) {
    return developmentUrl;
  }
  return pathToFileURL(join(currentDirectory, '../renderer/index.html')).href;
}

function createWindow(): BrowserWindow {
  const trustedRendererUrl = rendererUrl();
  const window = new BrowserWindow(
    createMainWindowOptions(join(currentDirectory, '../preload/index.js')),
  );
  installWindowSecurity(window, trustedRendererUrl);

  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadURL(trustedRendererUrl);

  return window;
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): Tray {
  const iconPath = join(app.getAppPath(), 'resources/icons/tray.png');
  const applicationTray = new Tray(nativeImage.createFromPath(iconPath));
  applicationTray.setToolTip('OmniPost 多平台内容工作台');
  applicationTray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate(
    showMainWindow,
    () => {
      isQuitting = true;
      app.quit();
    },
  )));
  applicationTray.on('double-click', showMainWindow);
  return applicationTray;
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

if (ownsSingleInstanceLock) app.whenReady().then(async () => {
  app.setAppUserModelId('com.omnipost.desktop');
  const database = openDatabase(join(app.getPath('userData'), 'omnipost.db'));
  const content = new ContentRepository(database);
  const accounts = new AccountRepository(
    database,
    new SecretVault(database, electronEncryptionProvider),
  );
  const publicationRepository = new PublicationRepository(database);
  const publishing = new PublishingService(
    content,
    accounts,
    publicationRepository,
  );
  const aiProfiles = new AiProfileRepository(database, electronEncryptionProvider);
  const aiVariants = new AiVariantService({
    content,
    profiles: aiProfiles,
    publications: publicationRepository,
    transport: new FetchAiTransport(),
  });
  const manualHandoff = new ManualHandoffService({
    revisions: content,
    save: async ({ suggestedName, content: exportContent }) => {
      const result = await dialog.showSaveDialog({
        title: '导出手动交接内容',
        defaultPath: join(app.getPath('downloads'), suggestedName),
      });
      if (result.canceled || result.filePath === '') return false;
      await writeFile(result.filePath, exportContent, 'utf8');
      return true;
    },
    openExternal: async (url) => { await shell.openExternal(url); },
  });
  const mediaStoreRoot = join(app.getPath('userData'), 'content-store');
  const artifactRoot = join(app.getPath('userData'), 'run-artifacts');
  const logPath = join(app.getPath('userData'), 'logs', 'omnipost.jsonl');
  const logger = new JsonLineLogger(logPath);
  const diagnostics = new DiagnosticsService({
    logPath,
    artifactRoot,
    saveLog: async ({ suggestedName, sourcePath }) => {
      const result = await dialog.showSaveDialog({
        title: '导出已脱敏诊断日志',
        defaultPath: join(app.getPath('downloads'), suggestedName),
      });
      if (result.canceled || result.filePath === '') return false;
      await copyFile(sourcePath, result.filePath);
      return true;
    },
    openPath: (path) => shell.openPath(path),
  });
  const persistentImporter = (localImporter: GenericMarkdownImporter | KnowCraftImporter) => (
    new PersistentSourceImporterAdapter({
      localImporter,
      database,
      repository: content,
      mediaStoreRoot,
    })
  );
  const imports = new ImportService({
    markdown: persistentImporter(new GenericMarkdownImporter({ mediaStoreRoot })),
    tgexporter: persistentImporter(new TgExporterImporter({ mediaStoreRoot })),
    knowcraft: persistentImporter(new KnowCraftImporter({ mediaStoreRoot })),
  }, async (kind: ImporterChoice) => {
    const labels: Record<ImporterChoice, string> = {
      markdown: '选择 Markdown 来源目录',
      tgexporter: '选择 tgexporter 只读来源目录',
      knowcraft: '选择 KnowCraft 只读来源目录',
    };
    const result = await dialog.showOpenDialog({
      title: labels[kind],
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }, content);
  registerApplicationIpc({
    ipc: createTrustedIpcRegistrar(ipcMain, rendererUrl()),
    content,
    imports,
    accounts,
    publishing,
    ai: {
      getProfile: () => aiProfiles.getSummary(),
      saveProfile: (input) => aiProfiles.save(input),
      generate: (input) => aiVariants.generate(input),
    },
    manualHandoff,
    diagnostics,
    autoStart: {
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath }),
    },
  });

  mainWindow = createWindow();
  tray = createTray();
  assistedBrowser = new AssistedBrowserEngine({
    profileRoot: join(app.getPath('userData'), 'browser-profiles'),
    artifactRoot,
    platforms: [
      { platform: 'wechat', editorUrl: 'https://mp.weixin.qq.com/', selectors: {} },
      { platform: 'douyin', editorUrl: 'https://creator.douyin.com/creator-micro/content/upload', selectors: {} },
      { platform: 'youtube', editorUrl: 'https://studio.youtube.com/', selectors: {} },
      { platform: 'zhihu', editorUrl: 'https://www.zhihu.com/creator', selectors: {} },
    ],
  });
  const browserPlatform = {
    WECHAT_OFFICIAL_ACCOUNT: 'wechat',
    DOUYIN: 'douyin',
    YOUTUBE: 'youtube',
    ZHIHU: 'zhihu',
  } as const;
  publishingRuntime = createPublishingRuntime({
    database,
    revisions: content,
    accounts,
    desktop: {
      showNotification: ({ title, body }) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      revealMainWindow: showMainWindow,
    },
    assistedFlows: {
      open: async ({ platform, prepared }) => {
        const openedAt = new Date().toISOString();
        const session = await assistedBrowser?.openEditor({
          platform: browserPlatform[platform],
          accountId: prepared.target.accountId,
        });
        if (session === undefined) throw new Error('Assisted browser is unavailable');
        return { id: session.sessionId, preparedId: prepared.id, status: 'OPEN', openedAt };
      },
    },
    onError: (error) => {
      void logger.write('error', 'scheduler-tick-failed', { error: String(error) });
    },
  });
  const shutdown = new ShutdownCoordinator({
    stopPublishing: () => publishingRuntime?.stop() ?? Promise.resolve(),
    closeBrowsers: () => assistedBrowser?.closeAll() ?? Promise.resolve(),
    destroyTray: () => {
      tray?.destroy();
      tray = null;
    },
    closeDatabase: () => database.close(),
  });
  let shutdownComplete = false;
  let shutdownStarted = false;

  app.on('activate', () => {
    showMainWindow();
  });

  app.on('second-instance', showMainWindow);

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void shutdown.run().then(
      () => {
        shutdownComplete = true;
        app.quit();
      },
      async (error: unknown) => {
        await logger.write('error', 'shutdown-failed', { error: String(error) });
        app.exit(1);
      },
    );
  });

  await pruneExpiredRunArtifacts(artifactRoot);
  if (isQuitting) return;
  await publishingRuntime.start();
}).catch(() => {
  dialog.showErrorBox('OmniPost 启动失败', '初始化本地数据或安全运行时失败。请查看诊断日志。');
  app.exit(1);
});

app.on('window-all-closed', () => undefined);
