import { describe, expect, it, vi } from 'vitest';

import {
  installWindowSecurity,
  isAllowedDevelopmentRendererUrl,
  isTrustedRendererUrl,
} from './window-security.js';

describe('renderer window security', () => {
  it('only accepts loopback HTTP development renderer URLs', () => {
    expect(isAllowedDevelopmentRendererUrl('http://localhost:5173')).toBe(true);
    expect(isAllowedDevelopmentRendererUrl('http://127.0.0.1:5173/app')).toBe(true);
    expect(isAllowedDevelopmentRendererUrl('https://evil.example/')).toBe(false);
    expect(isAllowedDevelopmentRendererUrl('file:///C:/tmp/index.html')).toBe(false);
    expect(isAllowedDevelopmentRendererUrl('not a url')).toBe(false);
  });

  it('allows only the exact renderer document, with an optional hash', () => {
    const trusted = 'file:///C:/OmniPost/out/renderer/index.html';
    expect(isTrustedRendererUrl(trusted, trusted)).toBe(true);
    expect(isTrustedRendererUrl(`${trusted}#settings`, trusted)).toBe(true);
    expect(isTrustedRendererUrl('https://example.com/', trusted)).toBe(false);
    expect(isTrustedRendererUrl('file:///C:/OmniPost/out/renderer/other.html', trusted)).toBe(false);
  });

  it('blocks top-level navigation, popups, webviews and permission requests', () => {
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    let permissionHandler: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
    const target = {
      webContents: {
        on: vi.fn((event: string, listener: (...arguments_: unknown[]) => void) => listeners.set(event, listener)),
        setWindowOpenHandler: vi.fn((handler: typeof openHandler) => { openHandler = handler; }),
        session: {
          setPermissionRequestHandler: vi.fn((handler: typeof permissionHandler) => { permissionHandler = handler; }),
        },
      },
    };
    installWindowSecurity(
      target as unknown as Parameters<typeof installWindowSecurity>[0],
      'file:///C:/OmniPost/out/renderer/index.html',
    );

    const externalNavigation = { preventDefault: vi.fn() };
    listeners.get('will-navigate')?.(externalNavigation, 'https://example.com/');
    expect(externalNavigation.preventDefault).toHaveBeenCalledOnce();
    const trustedNavigation = { preventDefault: vi.fn() };
    listeners.get('will-navigate')?.(trustedNavigation, 'file:///C:/OmniPost/out/renderer/index.html#queue');
    expect(trustedNavigation.preventDefault).not.toHaveBeenCalled();
    const webview = { preventDefault: vi.fn() };
    listeners.get('will-attach-webview')?.(webview);
    expect(webview.preventDefault).toHaveBeenCalledOnce();
    expect(openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    const permissionResult = vi.fn();
    permissionHandler?.({}, 'notifications', permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
  });
});
