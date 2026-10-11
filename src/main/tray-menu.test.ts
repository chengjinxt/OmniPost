import { describe, expect, it, vi } from 'vitest';

import { createTrayMenuTemplate } from './tray-menu.js';

describe('createTrayMenuTemplate', () => {
  it('offers explicit show and quit actions', () => {
    const show = vi.fn();
    const quit = vi.fn();
    const template = createTrayMenuTemplate(show, quit);

    expect(template.map((item) => 'label' in item ? item.label : item.type)).toEqual([
      '打开 OmniPost',
      'separator',
      '退出',
    ]);

    (template[0]?.click as (() => void) | undefined)?.();
    (template[2]?.click as (() => void) | undefined)?.();
    expect(show).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
