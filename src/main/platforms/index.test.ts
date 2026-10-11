import { describe, expect, it } from 'vitest';

import {
  DouyinAdapter,
  PLATFORM_IDS,
  WeChatAdapter,
  YouTubeAdapter,
  ZhihuAdapter,
  resolvePlatformCapability,
} from './index.js';

describe('platforms public API', () => {
  it('exports the capability registry and launch adapters', () => {
    expect(PLATFORM_IDS).toHaveLength(13);
    expect(resolvePlatformCapability).toBeTypeOf('function');
    expect([WeChatAdapter, DouyinAdapter, YouTubeAdapter, ZhihuAdapter]).toHaveLength(4);
  });
});
