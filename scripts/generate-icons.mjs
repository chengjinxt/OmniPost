import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceLogo = resolve(projectRoot, 'OmniPost.jpg');
const rendererLogo = resolve(projectRoot, 'src/renderer/public/OmniPost.jpg');
const iconDirectory = resolve(projectRoot, 'resources/icons');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'omnipost-icons-'));

await Promise.all([
  mkdir(dirname(rendererLogo), { recursive: true }),
  mkdir(iconDirectory, { recursive: true }),
]);

try {
  await copyFile(sourceLogo, rendererLogo);

  await Promise.all([
    sharp(sourceLogo).resize(512, 512).png().toFile(resolve(iconDirectory, 'icon.png')),
    sharp(sourceLogo)
      .resize(28, 28)
      .extend({ top: 2, bottom: 2, left: 2, right: 2, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(resolve(iconDirectory, 'tray.png')),
  ]);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoSources = await Promise.all(
    icoSizes.map(async (size) => {
      const output = resolve(temporaryDirectory, `icon-${size}.png`);
      await sharp(sourceLogo).resize(size, size).png().toFile(output);
      return output;
    }),
  );

  await writeFile(resolve(iconDirectory, 'icon.ico'), await pngToIco(icoSources));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
