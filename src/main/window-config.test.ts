import { describe, expect, it } from 'vitest';

import { createMainWindowOptions } from './window-config.js';

describe('createMainWindowOptions', () => {
  it('keeps renderer privileges isolated from Node.js', () => {
    const options = createMainWindowOptions('C:\\OmniPost\\preload.js');

    expect(options).toMatchObject({
      width: 1440,
      height: 920,
      minWidth: 1120,
      minHeight: 720,
      show: false,
      backgroundColor: '#f4f7fa',
      webPreferences: {
        preload: 'C:\\OmniPost\\preload.js',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });
});
