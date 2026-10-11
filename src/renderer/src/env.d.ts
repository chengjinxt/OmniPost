import type { OmniPostApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    omniPost: OmniPostApi;
  }
}

export {};
