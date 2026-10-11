import { describe, expect, it, vi } from 'vitest';

import { ShutdownCoordinator } from './shutdown-coordinator.js';

describe('ShutdownCoordinator', () => {
  it('waits for publishing and browser work before closing local resources', async () => {
    const events: string[] = [];
    let releasePublishing: (() => void) | undefined;
    const publishingStopped = new Promise<void>((resolve) => {
      releasePublishing = resolve;
    });
    const coordinator = new ShutdownCoordinator({
      stopPublishing: async () => {
        events.push('publishing:start');
        await publishingStopped;
        events.push('publishing:stopped');
      },
      closeBrowsers: async () => {
        events.push('browsers:closed');
      },
      destroyTray: () => {
        events.push('tray:destroyed');
      },
      closeDatabase: () => {
        events.push('database:closed');
      },
    });

    const first = coordinator.run();
    const repeated = coordinator.run();
    await Promise.resolve();
    expect(events).toEqual(['publishing:start']);

    releasePublishing?.();
    await Promise.all([first, repeated]);

    expect(events).toEqual([
      'publishing:start',
      'publishing:stopped',
      'browsers:closed',
      'tray:destroyed',
      'database:closed',
    ]);
  });

  it('runs cleanup only once', async () => {
    const closeDatabase = vi.fn();
    const coordinator = new ShutdownCoordinator({
      stopPublishing: vi.fn(),
      closeBrowsers: vi.fn(),
      destroyTray: vi.fn(),
      closeDatabase,
    });

    await coordinator.run();
    await coordinator.run();

    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
