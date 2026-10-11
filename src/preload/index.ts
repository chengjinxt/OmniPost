import { contextBridge, ipcRenderer } from 'electron';

import type { AppMetadata } from '../shared/ipc.js';

const omniPostApi = {
  getMetadata: (): Promise<AppMetadata> => ipcRenderer.invoke('app:get-metadata'),
};

contextBridge.exposeInMainWorld('omniPost', omniPostApi);
