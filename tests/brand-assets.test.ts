import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

describe('brand assets', () => {
  it('keeps the renderer copy byte-identical to the source logo', async () => {
    const [source, rendererCopy] = await Promise.all([
      readFile(resolve(projectRoot, 'OmniPost.jpg')),
      readFile(resolve(projectRoot, 'src/renderer/public/OmniPost.jpg')),
    ]);

    expect(rendererCopy).toEqual(source);
  });

  it('provides correctly sized app and tray PNG assets', async () => {
    const [appIcon, trayIcon] = await Promise.all([
      sharp(resolve(projectRoot, 'resources/icons/icon.png')).metadata(),
      sharp(resolve(projectRoot, 'resources/icons/tray.png')).metadata(),
    ]);

    expect(appIcon).toMatchObject({ format: 'png', width: 512, height: 512 });
    expect(trayIcon).toMatchObject({ format: 'png', width: 32, height: 32 });
  });

  it('provides a multi-resolution Windows icon', async () => {
    const icon = await readFile(resolve(projectRoot, 'resources/icons/icon.ico'));

    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(icon.readUInt16LE(4)).toBeGreaterThanOrEqual(5);
  });
});
