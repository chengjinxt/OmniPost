import { describe, expect, it } from 'vitest';

import { APP_METADATA } from './app-metadata.js';

describe('APP_METADATA', () => {
  it('exposes the Chinese desktop product identity', () => {
    expect(APP_METADATA).toEqual({
      name: 'OmniPost',
      tagline: '一次创作，多端抵达',
      defaultLocale: 'zh-CN',
      defaultTimeZone: 'Asia/Shanghai',
    });
  });
});
