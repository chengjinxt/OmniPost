import type { BrowserWindow } from 'electron';

export function isAllowedDevelopmentRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isTrustedRendererUrl(candidateValue: string, trustedValue: string): boolean {
  try {
    const candidate = new URL(candidateValue);
    const trusted = new URL(trustedValue);
    candidate.hash = '';
    trusted.hash = '';
    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}

export function installWindowSecurity(
  window: Pick<BrowserWindow, 'webContents'>,
  trustedRendererUrl: string,
): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, trustedRendererUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
