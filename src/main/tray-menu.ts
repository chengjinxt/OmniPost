import type { MenuItemConstructorOptions } from 'electron';

export function createTrayMenuTemplate(
  showWindow: () => void,
  quitApplication: () => void,
): MenuItemConstructorOptions[] {
  return [
    { label: '打开 OmniPost', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: quitApplication },
  ];
}
