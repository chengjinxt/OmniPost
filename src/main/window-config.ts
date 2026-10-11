import type { BrowserWindowConstructorOptions } from 'electron';

export function createMainWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f7fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
