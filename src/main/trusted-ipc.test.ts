import { describe, expect, it, vi } from 'vitest';

import { createTrustedIpcRegistrar } from './trusted-ipc.js';

describe('createTrustedIpcRegistrar', () => {
  it('invokes handlers only for the configured renderer document', async () => {
    let nativeHandler: ((event: unknown, ...arguments_: unknown[]) => unknown) | undefined;
    const native = {
      handle: vi.fn((_channel: string, handler: typeof nativeHandler) => { nativeHandler = handler; }),
    };
    const registrar = createTrustedIpcRegistrar(
      native,
      'file:///C:/OmniPost/out/renderer/index.html',
    );
    const handler = vi.fn((_event: unknown, value: unknown) => value);
    registrar.handle('safe:channel', handler);

    await expect(nativeHandler?.({
      senderFrame: { url: 'file:///C:/OmniPost/out/renderer/index.html#settings' },
    }, 'ok')).resolves.toBe('ok');
    await expect(nativeHandler?.({
      senderFrame: { url: 'https://evil.example/' },
    }, 'blocked')).rejects.toThrow('Untrusted IPC sender');
    await expect(nativeHandler?.({}, 'blocked')).rejects.toThrow('Untrusted IPC sender');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
