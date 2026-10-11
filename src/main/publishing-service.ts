import type {
  AccountConnection,
  ContentRevision,
  JsonObject,
  PlatformVariant,
  PublishJob,
  PublishPlan,
} from '../domain/index.js';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import {
  PLATFORM_IDS,
  resolvePlatformCapability,
  type CapabilityContext,
  type PlatformId,
} from './platforms/capability-registry.js';

export interface CreatePublishPlanRequest {
  revisionId: string;
  accountIds: string[];
  scheduledAt: string | null;
  platformFieldsByAccount?: Record<string, JsonObject>;
}

interface RevisionLookup {
  getRevision(id: string): ContentRevision | undefined;
}

interface AccountList {
  list(): Array<AccountConnection & {
    bindingVersion: number;
    credentialNames: string[];
    capabilityContext?: CapabilityContext;
  }>;
}

interface PublicationStore {
  createPlan(input: {
    revision: ContentRevision;
    variants: readonly PlatformVariant[];
    targets: Array<{
      accountId: string;
      platform: string;
      deliveryMode: AccountConnection['deliveryMode'];
      scheduledAt: string | null;
      platformFields: JsonObject;
    }>;
  }): {
    plan: Pick<PublishPlan, 'id' | 'revisionId' | 'variantIds' | 'contentHash' | 'targets'>;
    jobs: PublishJob[];
  };
  approve(planId: string, approvedBy: string): {
    plan: Pick<PublishPlan, 'id' | 'revisionId' | 'variantIds' | 'contentHash' | 'targets'>;
    jobs: PublishJob[];
  };
  listJobs(planId?: string): PublishJob[];
  listVariants(revisionId: string): PlatformVariant[];
}

export class PublishingService {
  public constructor(
    private readonly revisions: RevisionLookup,
    private readonly accounts: AccountList,
    private readonly publications: PublicationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createPlan(request: CreatePublishPlanRequest) {
    const revision = this.revisions.getRevision(request.revisionId);
    if (revision === undefined) throw new Error(`内容修订不存在：${request.revisionId}`);
    const accountIds = [...new Set(request.accountIds)];
    if (accountIds.length === 0) throw new Error('至少选择一个发布账号');
    if (
      request.scheduledAt !== null &&
      (!Number.isFinite(Date.parse(request.scheduledAt)) || Date.parse(request.scheduledAt) <= this.now().getTime())
    ) {
      throw new Error('定时发布时间必须是未来时间');
    }
    const accounts = this.accounts.list();
    const targetPlatforms = new Set(
      accountIds.map((accountId) => accounts.find((entry) => entry.id === accountId)?.platform)
        .filter((platform): platform is string => platform !== undefined),
    );
    const selectedPlatforms = new Set<string>();
    const variants = this.publications.listVariants(revision.id).filter((variant) => {
      if (!targetPlatforms.has(variant.platform) || selectedPlatforms.has(variant.platform)) return false;
      selectedPlatforms.add(variant.platform);
      return true;
    });
    const targets = accountIds.map((accountId) => {
      const account = accounts.find((entry) => entry.id === accountId && entry.enabled);
      if (account === undefined) throw new Error(`账号不存在或未启用：${accountId}`);
      if (!isPlatformId(account.platform)) throw new Error(`不支持的平台：${account.platform}`);
      const context = account.capabilityContext ?? safeDefaultCapabilityContext();
      const resolved = resolvePlatformCapability({
        platform: account.platform,
        contentKind: revision.kind,
        context,
      });
      const variant = variants.find((entry) => entry.platform === account.platform);
      const explicitFields = request.platformFieldsByAccount?.[account.id] ?? {};
      const platformFields = normalizePlatformFields({
        platform: account.platform,
        contentKind: revision.kind,
        revisionTitle: revision.title,
        revisionBodyMarkdown: revision.bodyMarkdown,
        variantTitle: variant?.title ?? null,
        variantBodyMarkdown: variant?.bodyMarkdown ?? null,
        variantFields: JSON.parse(
          JSON.stringify(variant?.platformFields ?? {}),
        ) as JsonObject,
        explicitFields,
        scheduledAt: request.scheduledAt,
      });
      return {
        accountId: account.id,
        platform: account.platform,
        deliveryMode: chooseDeliveryMode(account.deliveryMode, resolved.deliveryMode, context),
        scheduledAt: request.scheduledAt,
        platformFields: {
          ...platformFields,
          __omniPostAccountBindingVersion: account.bindingVersion,
          __omniPostContentHash: variant?.contentHash ?? revision.contentHash,
        },
      };
    });
    return this.publications.createPlan({ revision, variants, targets });
  }

  approve(planId: string) {
    return this.publications.approve(planId, 'local-user');
  }

  listJobs(): PublishJob[] {
    return this.publications.listJobs();
  }
}

function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

function safeDefaultCapabilityContext(): CapabilityContext {
  return {
    qualifications: [],
    scopes: [],
    probes: {
      directApi: 'UNKNOWN',
      remoteDraft: 'UNKNOWN',
      assistedBrowser: 'AVAILABLE',
    },
  };
}

function chooseDeliveryMode(
  preferred: AccountConnection['deliveryMode'],
  resolved: AccountConnection['deliveryMode'],
  context: CapabilityContext,
): AccountConnection['deliveryMode'] {
  if (resolved === 'UNSUPPORTED' || preferred === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (preferred === 'MANUAL_HANDOFF') return 'MANUAL_HANDOFF';
  if (preferred === 'ASSISTED_BROWSER') {
    return context.probes.assistedBrowser === 'AVAILABLE'
      ? 'ASSISTED_BROWSER'
      : 'MANUAL_HANDOFF';
  }
  if (preferred === 'REMOTE_DRAFT') {
    return resolved === 'DIRECT_API' || resolved === 'REMOTE_DRAFT'
      ? 'REMOTE_DRAFT'
      : resolved;
  }
  return resolved;
}

function renderMarkdownHtml(markdown: string): string {
  return String(unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(markdown));
}

function normalizePlatformFields(input: {
  platform: string;
  contentKind: ContentRevision['kind'];
  revisionTitle: string;
  revisionBodyMarkdown: string;
  variantTitle: string | null;
  variantBodyMarkdown: string | null;
  variantFields: JsonObject;
  explicitFields: JsonObject;
  scheduledAt: string | null;
}): JsonObject {
  const fields: JsonObject = {
    ...input.variantFields,
    ...input.explicitFields,
  };
  const title = nonEmptyString(
    fields.title,
    nonEmptyString(input.variantTitle, input.revisionTitle),
  );
  const bodyMarkdown = nonEmptyString(
    fields.bodyMarkdown,
    nonEmptyString(input.variantBodyMarkdown, input.revisionBodyMarkdown),
  );
  fields.title = title;
  fields.bodyMarkdown = bodyMarkdown;
  fields.bodyHtml = nonEmptyString(fields.bodyHtml, renderMarkdownHtml(bodyMarkdown));

  if (input.platform === 'WECHAT_OFFICIAL_ACCOUNT') {
    fields.author = nonEmptyString(fields.author, '');
    fields.digest = nonEmptyString(fields.digest, '');
    fields.contentSourceUrl = nonEmptyString(fields.contentSourceUrl, '');
    fields.coverMediaId = nonEmptyString(fields.coverMediaId, '');
    fields.openComments = fields.openComments === true;
    fields.onlyFansCanComment = fields.onlyFansCanComment === true;
  } else if (input.platform === 'DOUYIN') {
    fields.text = nonEmptyString(fields.text, title);
    fields.remoteMediaIds = stringValues(fields.remoteMediaIds);
  } else if (input.platform === 'YOUTUBE') {
    fields.uploadUri = nonEmptyString(fields.uploadUri, '');
    fields.description = nonEmptyString(fields.description, bodyMarkdown);
    fields.tags = stringValues(fields.tags);
    fields.categoryId = nonEmptyString(fields.categoryId, '22');
    fields.privacyStatus = input.scheduledAt === null
      ? nonEmptyString(fields.privacyStatus, 'private')
      : 'private';
  } else if (input.platform === 'ZHIHU') {
    fields.commentPermission = nonEmptyString(fields.commentPermission, 'all');
    fields.tableOfContentsEnabled = fields.tableOfContentsEnabled === true;
    fields.userConfirmed = true;
    fields.topicTokens = stringValues(fields.topicTokens);
    fields.imageUrls = stringValues(fields.imageUrls);
    if (
      typeof fields.creationStatement !== 'string' ||
      fields.creationStatement.length === 0 ||
      (input.contentKind === 'IMAGE_POST' && fields.creationStatement !== 'ai_creation')
    ) {
      delete fields.creationStatement;
    }
  }

  return fields;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
