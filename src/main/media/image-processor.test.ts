import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveImage } from './image-processor.js';

describe('deriveImage', () => {
  let directory: string;
  let source: string;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'omnipost-image-test-'));
    source = resolve(directory, 'source.jpg');
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#4263eb' },
    }).jpeg().toFile(source);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a bounded derivative and never changes the original', async () => {
    const output = resolve(directory, 'derived.webp');
    const beforeHash = sha256(await readFile(source));

    const result = await deriveImage(source, output, {
      width: 50,
      height: 50,
      format: 'webp',
      quality: 82,
    });

    expect(result).toMatchObject({ width: 50, height: 33, format: 'webp' });
    expect(sha256(await readFile(source))).toBe(beforeHash);
    expect(await sharp(await readFile(output)).metadata()).toMatchObject({ width: 50, height: 33, format: 'webp' });
  });

  it('refuses to overwrite the source asset', async () => {
    await expect(deriveImage(source, source, {
      width: 50,
      height: 50,
      format: 'jpeg',
      quality: 80,
    })).rejects.toThrow(/overwrite the source/i);
  });
});

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
