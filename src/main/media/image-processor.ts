import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';

const imageDerivativeOptionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(['jpeg', 'png', 'webp']),
  quality: z.number().int().min(1).max(100),
});

export type ImageDerivativeOptions = z.infer<typeof imageDerivativeOptionsSchema>;

export interface ImageDerivativeResult {
  path: string;
  width: number;
  height: number;
  format: string;
  byteSize: number;
}

export async function deriveImage(
  sourcePath: string,
  outputPath: string,
  inputOptions: ImageDerivativeOptions,
): Promise<ImageDerivativeResult> {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  const comparableSource = process.platform === 'win32' ? source.toLowerCase() : source;
  const comparableOutput = process.platform === 'win32' ? output.toLowerCase() : output;

  if (comparableSource === comparableOutput) {
    throw new Error('Image derivatives must not overwrite the source asset.');
  }

  const options = imageDerivativeOptionsSchema.parse(inputOptions);
  await mkdir(dirname(output), { recursive: true });

  let pipeline = sharp(source)
    .rotate()
    .resize({
      width: options.width,
      height: options.height,
      fit: 'inside',
      withoutEnlargement: true,
    });

  switch (options.format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: options.quality, mozjpeg: true });
      break;
    case 'png':
      pipeline = pipeline.png({ quality: options.quality });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: options.quality });
      break;
  }

  const result = await pipeline.toFile(output);
  return {
    path: output,
    width: result.width,
    height: result.height,
    format: result.format,
    byteSize: result.size,
  };
}
