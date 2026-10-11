import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_METADATA } from '../shared/app-metadata.js';
import { createMainWindowOptions } from './window-config.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createMainWindowOptions(join(currentDirectory, '../preload/index.js')),
  );

  window.once('ready-to-show', () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'));
  }

  return window;
}

ipcMain.handle('app:get-metadata', () => APP_METADATA);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
