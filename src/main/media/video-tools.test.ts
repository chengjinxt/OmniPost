import { describe, expect, it, vi } from 'vitest';

import { buildTranscodeArguments, probeVideo, transcodeVideo, type ProcessRunner } from './video-tools.js';

describe('probeVideo', () => {
  it('parses ffprobe output through an argument-only process runner', async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        format: { duration: '12.345', format_name: 'mov,mp4', bit_rate: '800000' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
    });

    await expect(probeVideo('C:/content/video one.mp4', runner)).resolves.toEqual({
      durationMs: 12_345,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      format: 'mov,mp4',
      bitRate: 800_000,
    });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[1]).toEqual([
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', 'C:/content/video one.mp4',
    ]);
  });
});

describe('video transcoding', () => {
  it('builds a safe argv list and keeps the original as a separate input', () => {
    const arguments_ = buildTranscodeArguments('C:/content/original.mp4', 'C:/derived/youtube.mp4', {
      width: 1920,
      height: 1080,
      videoBitRate: '8M',
    });

    expect(arguments_).toContain('C:/content/original.mp4');
    expect(arguments_.at(-1)).toBe('C:/derived/youtube.mp4');
    expect(arguments_).toContain('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
  });

  it('refuses to overwrite the source video', async () => {
    const runner = vi.fn<ProcessRunner>();
    await expect(transcodeVideo('C:/content/video.mp4', 'C:/content/video.mp4', {
      width: 1280,
      height: 720,
      videoBitRate: '5M',
    }, runner)).rejects.toThrow(/overwrite the source/i);
    expect(runner).not.toHaveBeenCalled();
  });
});
