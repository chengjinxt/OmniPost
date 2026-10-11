import type { ContentKind, DeliveryMode } from '../../domain/index.js';

export const PLATFORM_IDS = [
  'WECHAT_OFFICIAL_ACCOUNT',
  'WECHAT_CHANNELS',
  'DOUYIN',
  'TOUTIAO',
  'XIAOHONGSHU',
  'KUAISHOU',
  'YOUTUBE',
  'BAIJIAHAO',
  'CSDN',
  'JUEJIN',
  'ZHIHU',
  'SUBSTACK',
  'MEDIUM',
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export type PlatformContentKind = ContentKind;

export type ProbeAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CapabilityContext {
  qualifications: readonly string[];
  scopes: readonly string[];
  probes: {
    directApi: ProbeAvailability;
    remoteDraft: ProbeAvailability;
    assistedBrowser: ProbeAvailability;
  };
}

export interface ResolveCapabilityRequest {
  platform: PlatformId;
  contentKind: PlatformContentKind;
  context: CapabilityContext;
}

export interface ResolvedPlatformCapability {
  platform: PlatformId;
  contentKind: PlatformContentKind;
  deliveryMode: DeliveryMode;
  requiresUserConfirmation: boolean;
  allowsFieldPrefill: boolean;
  experimental: boolean;
  missingRequirements: string[];
}

interface DirectRule {
  kind: 'DIRECT';
  qualifications?: readonly string[];
  scopes: readonly string[];
  fallback: DeliveryMode;
}

interface FixedRule {
  kind: 'FIXED';
  mode: DeliveryMode;
}

interface BrowserRule {
  kind: 'BROWSER';
}

type CapabilityRule = DirectRule | FixedRule | BrowserRule;

const direct = (
  scopes: readonly string[],
  fallback: DeliveryMode,
  qualifications: readonly string[] = [],
): DirectRule => ({ kind: 'DIRECT', scopes, fallback, qualifications });

const fixed = (mode: DeliveryMode): FixedRule => ({ kind: 'FIXED', mode });

const browser = (): BrowserRule => ({ kind: 'BROWSER' });

const capabilityRules: Record<
  PlatformId,
  Record<PlatformContentKind, CapabilityRule>
> = {
  WECHAT_OFFICIAL_ACCOUNT: {
    ARTICLE: direct(
      ['wechat.freepublish'],
      'REMOTE_DRAFT',
      ['WECHAT_VERIFIED_ENTERPRISE'],
    ),
    IMAGE_POST: direct(
      ['wechat.freepublish'],
      'REMOTE_DRAFT',
      ['WECHAT_VERIFIED_ENTERPRISE'],
    ),
    VIDEO: fixed('MANUAL_HANDOFF'),
  },
  WECHAT_CHANNELS: {
    ARTICLE: fixed('UNSUPPORTED'),
    IMAGE_POST: browser(),
    VIDEO: browser(),
  },
  DOUYIN: {
    ARTICLE: fixed('UNSUPPORTED'),
    IMAGE_POST: direct(
      ['video.create.bind'],
      'MANUAL_HANDOFF',
      ['DOUYIN_APPROVED_APPLICATION'],
    ),
    VIDEO: direct(
      ['video.create.bind'],
      'MANUAL_HANDOFF',
      ['DOUYIN_APPROVED_APPLICATION'],
    ),
  },
  TOUTIAO: {
    ARTICLE: browser(),
    IMAGE_POST: browser(),
    VIDEO: direct(
      ['toutiao.video.create'],
      'MANUAL_HANDOFF',
      ['TOUTIAO_APPROVED_APPLICATION'],
    ),
  },
  XIAOHONGSHU: {
    ARTICLE: fixed('UNSUPPORTED'),
    IMAGE_POST: fixed('MANUAL_HANDOFF'),
    VIDEO: fixed('MANUAL_HANDOFF'),
  },
  KUAISHOU: {
    ARTICLE: fixed('UNSUPPORTED'),
    IMAGE_POST: fixed('MANUAL_HANDOFF'),
    VIDEO: direct(
      ['user_video_publish'],
      'MANUAL_HANDOFF',
      ['KUAISHOU_APPROVED_APPLICATION'],
    ),
  },
  YOUTUBE: {
    ARTICLE: fixed('UNSUPPORTED'),
    IMAGE_POST: fixed('UNSUPPORTED'),
    VIDEO: direct(['youtube.upload'], 'MANUAL_HANDOFF'),
  },
  BAIJIAHAO: {
    ARTICLE: direct(
      ['baijiahao.publish'],
      'ASSISTED_BROWSER',
      ['BAIJIAHAO_APPROVED_ACCOUNT'],
    ),
    IMAGE_POST: direct(
      ['baijiahao.publish'],
      'ASSISTED_BROWSER',
      ['BAIJIAHAO_APPROVED_ACCOUNT'],
    ),
    VIDEO: direct(
      ['baijiahao.publish'],
      'ASSISTED_BROWSER',
      ['BAIJIAHAO_APPROVED_ACCOUNT'],
    ),
  },
  CSDN: {
    ARTICLE: browser(),
    IMAGE_POST: fixed('UNSUPPORTED'),
    VIDEO: fixed('UNSUPPORTED'),
  },
  JUEJIN: {
    ARTICLE: browser(),
    IMAGE_POST: fixed('UNSUPPORTED'),
    VIDEO: fixed('UNSUPPORTED'),
  },
  ZHIHU: {
    ARTICLE: direct(
      ['zhihu.publish'],
      'MANUAL_HANDOFF',
      ['ZHIHU_PUBLISHER_ACCESS'],
    ),
    IMAGE_POST: direct(
      ['zhihu.publish'],
      'MANUAL_HANDOFF',
      ['ZHIHU_PUBLISHER_ACCESS'],
    ),
    VIDEO: fixed('UNSUPPORTED'),
  },
  SUBSTACK: {
    ARTICLE: browser(),
    IMAGE_POST: fixed('UNSUPPORTED'),
    VIDEO: browser(),
  },
  MEDIUM: {
    ARTICLE: fixed('MANUAL_HANDOFF'),
    IMAGE_POST: fixed('MANUAL_HANDOFF'),
    VIDEO: fixed('UNSUPPORTED'),
  },
};

function missingRequirements(
  rule: DirectRule,
  context: CapabilityContext,
): string[] {
  const qualifications = rule.qualifications ?? [];

  return [
    ...qualifications.filter(
      (requirement) => !context.qualifications.includes(requirement),
    ),
    ...rule.scopes.filter((scope) => !context.scopes.includes(scope)),
  ];
}

function resolveDirectRule(
  platform: PlatformId,
  rule: DirectRule,
  context: CapabilityContext,
): { mode: DeliveryMode; missing: string[] } {
  const missing = missingRequirements(rule, context);
  if (missing.length === 0 && context.probes.directApi === 'AVAILABLE') {
    return { mode: 'DIRECT_API', missing };
  }

  if (platform === 'WECHAT_OFFICIAL_ACCOUNT') {
    return {
      mode:
        context.scopes.includes('wechat.draft') &&
        context.probes.remoteDraft === 'AVAILABLE'
          ? 'REMOTE_DRAFT'
          : 'MANUAL_HANDOFF',
      missing,
    };
  }

  if (
    rule.fallback === 'ASSISTED_BROWSER' &&
    context.probes.assistedBrowser !== 'AVAILABLE'
  ) {
    return { mode: 'MANUAL_HANDOFF', missing };
  }

  return { mode: rule.fallback, missing };
}

export function resolvePlatformCapability(
  request: ResolveCapabilityRequest,
): ResolvedPlatformCapability {
  const rule = capabilityRules[request.platform][request.contentKind];
  let deliveryMode: DeliveryMode;
  let missing: string[] = [];

  if (rule.kind === 'DIRECT') {
    const resolved = resolveDirectRule(request.platform, rule, request.context);
    deliveryMode = resolved.mode;
    missing = resolved.missing;
  } else if (rule.kind === 'BROWSER') {
    deliveryMode =
      request.context.probes.assistedBrowser === 'AVAILABLE'
        ? 'ASSISTED_BROWSER'
        : 'MANUAL_HANDOFF';
  } else {
    deliveryMode = rule.mode;
  }

  return {
    platform: request.platform,
    contentKind: request.contentKind,
    deliveryMode,
    requiresUserConfirmation: deliveryMode !== 'UNSUPPORTED',
    allowsFieldPrefill:
      request.platform !== 'MEDIUM' && deliveryMode !== 'UNSUPPORTED',
    experimental: request.platform === 'ZHIHU' || request.platform === 'BAIJIAHAO',
    missingRequirements: missing,
  };
}
