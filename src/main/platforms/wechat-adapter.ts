import {
  ContentKind,
  DeliveryMode,
  type AccountCapabilities,
  type AssistedSession,
  type PlatformAdapter,
  type PreparedPublication,
  type PublishTarget,
  type RemotePublicationStatus,
  type SubmissionReceipt,
  type ValidationIssue,
} from '../../domain/index.js';
import { resolvePlatformCapability } from './capability-registry.js';
import {
  AdapterRuntimeStore,
  PlatformValidationError,
  accountBindingValidationIssue,
  booleanField,
  buildAssistedSession,
  buildPreparedPublication,
  buildSubmissionReceipt,
  capabilitiesFromContext,
  deliveryModesWithAssistedBrowser,
  isCompatibleDeliveryMode,
  requireAccount,
  requireRevision,
  responseObject,
  stringField,
  throwIfPlatformOperationAborted,
  validationIssue,
  type AdapterDependencies,
} from './adapter-runtime.js';

interface WeChatPayload {
  articles: Array<{
    title: string;
    author: string;
    digest: string;
    content: string;
    content_source_url: string;
    thumb_media_id: string;
    need_open_comment: 0 | 1;
    only_fans_can_comment: 0 | 1;
  }>;
}

const PLATFORM = 'wechat';
const API_ROOT = 'https://api.weixin.qq.com/cgi-bin';

export class WeChatAdapter implements PlatformAdapter {
  readonly #transport: AdapterDependencies['transport'];
  readonly #revisions: AdapterDependencies['revisions'];
  readonly #accounts: AdapterDependencies['accounts'];
  readonly #now: () => string;
  readonly #store = new AdapterRuntimeStore<WeChatPayload>();

  constructor(dependencies: AdapterDependencies) {
    this.#transport = dependencies.transport;
    this.#revisions = dependencies.revisions;
    this.#accounts = dependencies.accounts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    const account = await requireAccount(this.#accounts, accountId);
    const modes = [ContentKind.ARTICLE, ContentKind.IMAGE_POST].map(
      (contentKind) =>
        resolvePlatformCapability({
          platform: 'WECHAT_OFFICIAL_ACCOUNT',
          contentKind,
          context: account.capabilityContext,
        }).deliveryMode,
    );

    return capabilitiesFromContext({
      accountId,
      platform: PLATFORM,
      context: account.capabilityContext,
      deliveryModes: deliveryModesWithAssistedBrowser(
        modes,
        account.capabilityContext.probes,
      ),
      contentKinds: [ContentKind.ARTICLE, ContentKind.IMAGE_POST],
      qualificationLabels: {
        WECHAT_VERIFIED_ENTERPRISE: 'Verified enterprise WeChat account',
      },
      scopeNames: ['wechat.freepublish', 'wechat.draft'],
      supportsDrafts: account.capabilityContext.probes.remoteDraft === 'AVAILABLE',
      supportsScheduling: false,
      supportsRemoteStatus: modes.includes(DeliveryMode.DIRECT_API),
      checkedAt: this.#now(),
    });
  }

  async validate(
    revisionId: string,
    target: PublishTarget,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const revision = await this.#revisions.getRevision(revisionId);
    const account = await this.#accounts.getAccount(target.accountId);

    if (!revision) return [validationIssue('revision-not-found', 'Content revision not found')];
    if (!account) return [validationIssue('account-not-found', 'WeChat account not found')];
    const accountBindingIssue = accountBindingValidationIssue(target, account);
    if (accountBindingIssue !== null) issues.push(accountBindingIssue);
    if (target.platform !== PLATFORM) {
      issues.push(validationIssue('platform-mismatch', 'Target platform must be wechat'));
    }
    if (revision.kind !== ContentKind.ARTICLE && revision.kind !== ContentKind.IMAGE_POST) {
      issues.push(
        validationIssue('content-kind-unsupported', 'WeChat adapter supports article content'),
      );
    }

    const resolved = resolvePlatformCapability({
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      contentKind: revision.kind,
      context: account.capabilityContext,
    });
    if (!isCompatibleDeliveryMode(resolved.deliveryMode, target.deliveryMode)) {
      issues.push(
        validationIssue(
          'capability-unavailable',
          `Requested ${target.deliveryMode} but account supports ${resolved.deliveryMode}`,
          'deliveryMode',
        ),
      );
    }
    const usesOfficialApi = target.deliveryMode === DeliveryMode.DIRECT_API ||
      target.deliveryMode === DeliveryMode.REMOTE_DRAFT;
    if (usesOfficialApi && !account.credentials.accessToken) {
      issues.push(validationIssue('credential-missing', 'WeChat access token is required'));
    }
    if (!revision.title.trim()) {
      issues.push(validationIssue('title-required', 'Title is required', 'title'));
    }
    if (!stringField(target.platformFields, 'bodyHtml')) {
      issues.push(validationIssue('body-html-required', 'Rendered HTML is required', 'bodyHtml'));
    }
    if (usesOfficialApi && !stringField(target.platformFields, 'coverMediaId')) {
      issues.push(
        validationIssue('cover-media-required', 'WeChat cover media ID is required', 'coverMediaId'),
      );
    }
    return issues;
  }

  async prepare(
    revisionId: string,
    target: PublishTarget,
  ): Promise<PreparedPublication> {
    const issues = await this.validate(revisionId, target);
    if (issues.length > 0) throw new PlatformValidationError(issues);

    const revision = await requireRevision(this.#revisions, revisionId);
    const account = await requireAccount(this.#accounts, target.accountId, target);
    const prepared = buildPreparedPublication(revision, target, this.#now());
    const payload: WeChatPayload = {
      articles: [
        {
          title: stringField(target.platformFields, 'title') ?? revision.title,
          author: stringField(target.platformFields, 'author') ?? '',
          digest: stringField(target.platformFields, 'digest') ?? '',
          content: stringField(target.platformFields, 'bodyHtml') ?? '',
          content_source_url:
            stringField(target.platformFields, 'contentSourceUrl') ?? '',
          thumb_media_id:
            stringField(target.platformFields, 'coverMediaId') ?? '',
          need_open_comment: booleanField(target.platformFields, 'openComments')
            ? 1
            : 0,
          only_fans_can_comment: booleanField(
            target.platformFields,
            'onlyFansCanComment',
          )
            ? 1
            : 0,
        },
      ],
    };
    this.#store.savePrepared({
      prepared,
      revision,
      account,
      payload,
      remoteDraftId: null,
    });
    return prepared;
  }

  async submit(preparedId: string): Promise<SubmissionReceipt> {
    const stored = this.#store.getPrepared(preparedId);
    const accessToken = stored.account.credentials.accessToken ?? '';
    const draftResponse = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: `${API_ROOT}/draft/add?access_token=${encodeURIComponent(accessToken)}`,
        headers: { 'content-type': 'application/json' },
        body: stored.payload,
        idempotencyKey: stored.prepared.idempotencyKey,
      }),
    );
    const remoteDraftId = typeof draftResponse.media_id === 'string'
      ? draftResponse.media_id
      : null;
    if (!remoteDraftId) throw new Error('WeChat draft response did not include media_id');
    let remoteId: string | null = remoteDraftId;

    if (stored.prepared.target.deliveryMode === DeliveryMode.DIRECT_API) {
      throwIfPlatformOperationAborted();
      const response = responseObject(
        await this.#transport.send({
          method: 'POST',
          url: `${API_ROOT}/freepublish/submit?access_token=${encodeURIComponent(accessToken)}`,
          headers: { 'content-type': 'application/json' },
          body: { media_id: remoteDraftId },
          idempotencyKey: stored.prepared.idempotencyKey,
        }),
      );
      remoteId = typeof response.publish_id === 'string' ? response.publish_id : null;
      if (!remoteId) throw new Error('WeChat publish response did not include publish_id');
    }

    const receipt = buildSubmissionReceipt(
      stored.prepared,
      PLATFORM,
      remoteId,
      this.#now(),
      stored.prepared.target.deliveryMode === DeliveryMode.REMOTE_DRAFT
        ? {
            state: 'NEEDS_ACTION',
            url: null,
            message: 'Remote draft requires user publication',
          }
        : null,
    );
    return receipt;
  }

  async poll(receipt: SubmissionReceipt): Promise<RemotePublicationStatus> {
    if (receipt.deliveryMode === DeliveryMode.REMOTE_DRAFT) {
      return {
        state: receipt.status?.state ?? 'NEEDS_ACTION',
        remoteId: receipt.remoteId,
        url: receipt.status?.url ?? null,
        message: receipt.status?.message ?? 'Remote draft requires user publication',
        checkedAt: this.#now(),
      };
    }

    const account = await requireAccount(this.#accounts, receipt.accountId);
    const accessToken = account.credentials.accessToken ?? '';
    const response = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: `${API_ROOT}/freepublish/get?access_token=${encodeURIComponent(accessToken)}`,
        headers: { 'content-type': 'application/json' },
        body: { publish_id: receipt.remoteId },
        idempotencyKey: receipt.idempotencyKey,
      }),
    );
    const status = typeof response.publish_status === 'number' ? response.publish_status : -1;
    const detail = response.article_detail as
      | { item?: Array<{ article_url?: unknown }> }
      | undefined;
    const url = detail?.item?.find(
      (item) => typeof item.article_url === 'string',
    )?.article_url;
    const articleId =
      typeof response.article_id === 'string' ? response.article_id : receipt.remoteId;

    return {
      state:
        status === 0
          ? 'PUBLISHED'
          : status === 1
            ? 'PROCESSING'
            : [2, 3, 4, 6].includes(status)
              ? 'REJECTED'
              : status === 5
                ? 'NEEDS_ACTION'
                : 'UNKNOWN',
      remoteId: articleId,
      url: typeof url === 'string' ? url : null,
      message: status === 0 ? null : `WeChat publish status ${status}`,
      checkedAt: this.#now(),
    };
  }

  async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    this.#store.getPrepared(preparedId);
    return buildAssistedSession(preparedId, this.#now());
  }
}
