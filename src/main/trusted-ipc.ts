import type { IpcRegistrar } from './ipc-handlers.js';
import { isTrustedRendererUrl } from './window-security.js';

interface NativeIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown): void;
}

export function createTrustedIpcRegistrar(
  native: NativeIpcRegistrar,
  trustedRendererUrl: string,
): IpcRegistrar {
  return {
    handle(channel, listener) {
      native.handle(channel, async (event, ...arguments_) => {
        const senderUrl = senderFrameUrl(event);
        if (senderUrl === null || !isTrustedRendererUrl(senderUrl, trustedRendererUrl)) {
          throw new Error('Untrusted IPC sender');
        }
        return listener(event, ...arguments_);
      });
    },
  };
}

function senderFrameUrl(event: unknown): string | null {
  if (event === null || typeof event !== 'object' || !('senderFrame' in event)) return null;
  const senderFrame = event.senderFrame;
  if (senderFrame === null || typeof senderFrame !== 'object' || !('url' in senderFrame)) return null;
  return typeof senderFrame.url === 'string' ? senderFrame.url : null;
}
