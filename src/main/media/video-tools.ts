import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string | null;
const ffprobePath = (require('ffprobe-static') as { path: string }).path;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (executable: string, arguments_: readonly string[]) => Promise<ProcessResult>;

const ffprobeOutputSchema = z.object({
  format: z.object({
    duration: z.string(),
    format_name: z.string(),
    bit_rate: z.string().optional(),
  }),
  streams: z.array(z.object({
    codec_type: z.string(),
    codec_name: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).passthrough()),
});

const transcodeOptionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoBitRate: z.string().regex(/^\d+(?:[kKmM])?$/),
});

export type VideoTranscodeOptions = z.infer<typeof transcodeOptionsSchema>;

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
  format: string;
  bitRate?: number;
}

export const runProcess: ProcessRunner = (executable, arguments_) => new Promise((resolveResult, reject) => {
  const child = spawn(executable, [...arguments_], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (exitCode) => resolveResult({ exitCode: exitCode ?? -1, stdout, stderr }));
});

export async function probeVideo(
  sourcePath: string,
  runner: ProcessRunner = runProcess,
): Promise<VideoMetadata> {
  const result = await runner(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    sourcePath,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`ffprobe failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
  }

  const parsed = ffprobeOutputSchema.parse(JSON.parse(result.stdout));
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  if (video?.width === undefined || video.height === undefined) {
    throw new Error('The selected file does not contain a readable video stream.');
  }
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format.duration);
  const bitRate = parsed.format.bit_rate === undefined ? undefined : Number(parsed.format.bit_rate);

  return {
    durationMs: Math.round(durationSeconds * 1_000),
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name ?? 'unknown',
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
    format: parsed.format.format_name,
    ...(bitRate === undefined || !Number.isFinite(bitRate) ? {} : { bitRate }),
  };
}

export function buildTranscodeArguments(
  sourcePath: string,
  outputPath: string,
  inputOptions: VideoTranscodeOptions,
): string[] {
  const options = transcodeOptionsSchema.parse(inputOptions);
  const filter = `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,`
    + `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`;

  return [
    '-hide_banner', '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', filter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-b:v', options.videoBitRate,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export async function transcodeVideo(
  sourcePath: string,
  outputPath: string,
  options: VideoTranscodeOptions,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  const comparableSource = process.platform === 'win32' ? source.toLowerCase() : source;
  const comparableOutput = process.platform === 'win32' ? output.toLowerCase() : output;
  if (comparableSource === comparableOutput) {
    throw new Error('Video derivatives must not overwrite the source asset.');
  }
  if (ffmpegPath === null) {
    throw new Error('The bundled FFmpeg binary is unavailable for this platform.');
  }

  await mkdir(dirname(output), { recursive: true });
  const result = await runner(ffmpegPath, buildTranscodeArguments(sourcePath, outputPath, options));
  if (result.exitCode !== 0) {
    throw new Error(`FFmpeg failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
  }
}
