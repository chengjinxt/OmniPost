import { describe, expect, it } from 'vitest';

import {
  PLATFORM_IDS,
  resolvePlatformCapability,
  type CapabilityContext,
  type PlatformId,
} from './capability-registry.js';

const contentKinds = ['ARTICLE', 'IMAGE_POST', 'VIDEO'] as const;

const fullyQualifiedContext: CapabilityContext = {
  qualifications: [
    'WECHAT_VERIFIED_ENTERPRISE',
    'DOUYIN_APPROVED_APPLICATION',
    'TOUTIAO_APPROVED_APPLICATION',
    'KUAISHOU_APPROVED_APPLICATION',
    'BAIJIAHAO_APPROVED_ACCOUNT',
    'ZHIHU_PUBLISHER_ACCESS',
  ],
  scopes: [
    'wechat.freepublish',
    'wechat.draft',
    'video.create.bind',
    'toutiao.video.create',
    'user_video_publish',
    'youtube.upload',
    'baijiahao.publish',
    'zhihu.publish',
  ],
  probes: {
    directApi: 'AVAILABLE',
    remoteDraft: 'AVAILABLE',
    assistedBrowser: 'AVAILABLE',
  },
};

const expectedFullyQualifiedMatrix: Record<
  PlatformId,
  Record<(typeof contentKinds)[number], string>
> = {
  WECHAT_OFFICIAL_ACCOUNT: {
    ARTICLE: 'DIRECT_API',
    IMAGE_POST: 'DIRECT_API',
    VIDEO: 'MANUAL_HANDOFF',
  },
  WECHAT_CHANNELS: {
    ARTICLE: 'UNSUPPORTED',
    IMAGE_POST: 'ASSISTED_BROWSER',
    VIDEO: 'ASSISTED_BROWSER',
  },
  DOUYIN: {
    ARTICLE: 'UNSUPPORTED',
    IMAGE_POST: 'DIRECT_API',
    VIDEO: 'DIRECT_API',
  },
  TOUTIAO: {
    ARTICLE: 'ASSISTED_BROWSER',
    IMAGE_POST: 'ASSISTED_BROWSER',
    VIDEO: 'DIRECT_API',
  },
  XIAOHONGSHU: {
    ARTICLE: 'UNSUPPORTED',
    IMAGE_POST: 'MANUAL_HANDOFF',
    VIDEO: 'MANUAL_HANDOFF',
  },
  KUAISHOU: {
    ARTICLE: 'UNSUPPORTED',
    IMAGE_POST: 'MANUAL_HANDOFF',
    VIDEO: 'DIRECT_API',
  },
  YOUTUBE: {
    ARTICLE: 'UNSUPPORTED',
    IMAGE_POST: 'UNSUPPORTED',
    VIDEO: 'DIRECT_API',
  },
  BAIJIAHAO: {
    ARTICLE: 'DIRECT_API',
    IMAGE_POST: 'DIRECT_API',
    VIDEO: 'DIRECT_API',
  },
  CSDN: {
    ARTICLE: 'ASSISTED_BROWSER',
    IMAGE_POST: 'UNSUPPORTED',
    VIDEO: 'UNSUPPORTED',
  },
  JUEJIN: {
    ARTICLE: 'ASSISTED_BROWSER',
    IMAGE_POST: 'UNSUPPORTED',
    VIDEO: 'UNSUPPORTED',
  },
  ZHIHU: {
    ARTICLE: 'DIRECT_API',
    IMAGE_POST: 'DIRECT_API',
    VIDEO: 'UNSUPPORTED',
  },
  SUBSTACK: {
    ARTICLE: 'ASSISTED_BROWSER',
    IMAGE_POST: 'UNSUPPORTED',
    VIDEO: 'ASSISTED_BROWSER',
  },
  MEDIUM: {
    ARTICLE: 'MANUAL_HANDOFF',
    IMAGE_POST: 'MANUAL_HANDOFF',
    VIDEO: 'UNSUPPORTED',
  },
};

describe('platform capability registry', () => {
  it('defines an explicit delivery mode for every platform and content kind', () => {
    expect(PLATFORM_IDS).toHaveLength(13);

    for (const platform of PLATFORM_IDS) {
      for (const contentKind of contentKinds) {
        const capability = resolvePlatformCapability({
          platform,
          contentKind,
          context: fullyQualifiedContext,
        });

        expect(capability.deliveryMode).toBe(
          expectedFullyQualifiedMatrix[platform][contentKind],
        );
      }
    }
  });

  it('downgrades an unverified WeChat account to a remote draft when draft access is probed', () => {
    const capability = resolvePlatformCapability({
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      contentKind: 'ARTICLE',
      context: {
        qualifications: [],
        scopes: ['wechat.draft'],
        probes: {
          directApi: 'UNAVAILABLE',
          remoteDraft: 'AVAILABLE',
          assistedBrowser: 'UNKNOWN',
        },
      },
    });

    expect(capability).toMatchObject({
      deliveryMode: 'REMOTE_DRAFT',
      requiresUserConfirmation: true,
      missingRequirements: ['WECHAT_VERIFIED_ENTERPRISE', 'wechat.freepublish'],
    });
  });

  it('uses manual handoff when WeChat draft access is not available', () => {
    const capability = resolvePlatformCapability({
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      contentKind: 'ARTICLE',
      context: {
        qualifications: [],
        scopes: [],
        probes: {
          directApi: 'UNAVAILABLE',
          remoteDraft: 'UNAVAILABLE',
          assistedBrowser: 'UNKNOWN',
        },
      },
    });

    expect(capability.deliveryMode).toBe('MANUAL_HANDOFF');
  });

  it('uses manual handoff when a browser-only integration has not passed its runtime probe', () => {
    const capability = resolvePlatformCapability({
      platform: 'CSDN',
      contentKind: 'ARTICLE',
      context: {
        qualifications: [],
        scopes: [],
        probes: {
          directApi: 'UNAVAILABLE',
          remoteDraft: 'UNAVAILABLE',
          assistedBrowser: 'UNKNOWN',
        },
      },
    });

    expect(capability).toMatchObject({
      deliveryMode: 'MANUAL_HANDOFF',
      requiresUserConfirmation: true,
    });
  });

  it('never elevates Medium to an automated mode or allows field prefill', () => {
    for (const contentKind of contentKinds) {
      const capability = resolvePlatformCapability({
        platform: 'MEDIUM',
        contentKind,
        context: {
          qualifications: ['MEDIUM_LEGACY_TOKEN'],
          scopes: ['medium.publish'],
          probes: {
            directApi: 'AVAILABLE',
            remoteDraft: 'AVAILABLE',
            assistedBrowser: 'AVAILABLE',
          },
        },
      });

      expect(['MANUAL_HANDOFF', 'UNSUPPORTED']).toContain(capability.deliveryMode);
      expect(capability.allowsFieldPrefill).toBe(false);
    }
  });

  it('keeps Zhihu experimental and rejects video publishing', () => {
    const article = resolvePlatformCapability({
      platform: 'ZHIHU',
      contentKind: 'ARTICLE',
      context: fullyQualifiedContext,
    });
    const video = resolvePlatformCapability({
      platform: 'ZHIHU',
      contentKind: 'VIDEO',
      context: fullyQualifiedContext,
    });

    expect(article).toMatchObject({
      deliveryMode: 'DIRECT_API',
      experimental: true,
      requiresUserConfirmation: true,
    });
    expect(video).toMatchObject({
      deliveryMode: 'UNSUPPORTED',
      experimental: true,
    });
  });
});
