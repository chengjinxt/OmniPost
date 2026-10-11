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
  buildAssistedSession,
  buildPreparedPublication,
  buildSubmissionReceipt,
  capabilitiesFromContext,
  deliveryModesWithAssistedBrowser,
  isCompatibleDeliveryMode,
  requireAccount,
  requireRevision,
  responseObject,
  stringArrayField,
  stringField,
  validationIssue,
  type AdapterDependencies,
} from './adapter-runtime.js';

interface DouyinPayload {
  text: string;
  remoteMediaIds: string[];
}

const PLATFORM = 'douyin';
const API_ROOT = 'https://open.douyin.com';

export class DouyinAdapter implements PlatformAdapter {
  readonly #transport: AdapterDependencies['transport'];
  readonly #revisions: AdapterDependencies['revisions'];
  readonly #accounts: AdapterDependencies['accounts'];
  readonly #now: () => string;
  readonly #store = new AdapterRuntimeStore<DouyinPayload>();

  constructor(dependencies: AdapterDependencies) {
    this.#transport = dependencies.transport;
    this.#revisions = dependencies.revisions;
    this.#accounts = dependencies.accounts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    const account = await requireAccount(this.#accounts, accountId);
    const deliveryModes = [ContentKind.IMAGE_POST, ContentKind.VIDEO].map(
      (contentKind) =>
        resolvePlatformCapability({
          platform: 'DOUYIN',
          contentKind,
          context: account.capabilityContext,
        }).deliveryMode,
    );
    return capabilitiesFromContext({
      accountId,
      platform: PLATFORM,
      context: account.capabilityContext,
      deliveryModes: deliveryModesWithAssistedBrowser(
        deliveryModes,
        account.capabilityContext.probes,
      ),
      contentKinds: [ContentKind.IMAGE_POST, ContentKind.VIDEO],
      qualificationLabels: {
        DOUYIN_APPROVED_APPLICATION: 'Approved Douyin application',
      },
      scopeNames: ['video.create.bind', 'posting.behavior'],
      supportsDrafts: false,
      supportsScheduling: false,
      supportsRemoteStatus:
        deliveryModes.includes(DeliveryMode.DIRECT_API) &&
        account.capabilityContext.scopes.includes('posting.behavior'),
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
    if (!account) return [validationIssue('account-not-found', 'Douyin account not found')];
    if (target.platform !== PLATFORM) {
      issues.push(validationIssue('platform-mismatch', 'Target platform must be douyin'));
    }
    if (revision.kind !== ContentKind.IMAGE_POST && revision.kind !== ContentKind.VIDEO) {
      issues.push(
        validationIssue(
          'content-kind-unsupported',
          'Douyin adapter supports image posts and videos only',
        ),
      );
      return issues;
    }
    const resolved = resolvePlatformCapability({
      platform: 'DOUYIN',
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
    if (target.deliveryMode === DeliveryMode.DIRECT_API) {
      if (!account.credentials.accessToken) {
        issues.push(validationIssue('credential-missing', 'Douyin access token is required'));
      }
      if (!account.credentials.openId) {
        issues.push(validationIssue('open-id-missing', 'Douyin open_id is required'));
      }
      if (stringArrayField(target.platformFields, 'remoteMediaIds').length === 0) {
        issues.push(
          validationIssue(
            'remote-media-required',
            'Uploaded Douyin media ID is required',
            'remoteMediaIds',
          ),
        );
      }
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
    const account = await requireAccount(this.#accounts, target.accountId);
    const prepared = buildPreparedPublication(revision, target, this.#now());
    this.#store.savePrepared({
      prepared,
      revision,
      account,
      payload: {
        text:
          stringField(target.platformFields, 'text') ??
          stringField(target.platformFields, 'title') ??
          revision.title,
        remoteMediaIds: stringArrayField(target.platformFields, 'remoteMediaIds'),
      },
      remoteDraftId: null,
    });
    return prepared;
  }

  async submit(preparedId: string): Promise<SubmissionReceipt> {
    const stored = this.#store.getPrepared(preparedId);
    if (stored.prepared.target.deliveryMode !== DeliveryMode.DIRECT_API) {
      const receipt = buildSubmissionReceipt(
        stored.prepared,
        PLATFORM,
        null,
        this.#now(),
        {
          state: 'NEEDS_ACTION',
          url: null,
          message: 'Douyin publication requires user handoff',
        },
      );
      return receipt;
    }

    const openId = stored.account.credentials.openId ?? '';
    const isVideo = stored.revision.kind === ContentKind.VIDEO;
    const body = isVideo
      ? {
          video_id: stored.payload.remoteMediaIds[0],
          text: stored.payload.text,
        }
      : {
          image_list: stored.payload.remoteMediaIds,
          text: stored.payload.text,
        };
    const response = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: `${API_ROOT}/api/douyin/v1/video/${isVideo ? 'create_video' : 'create_image_text'}/?open_id=${encodeURIComponent(openId)}`,
        headers: {
          'access-token': stored.account.credentials.accessToken ?? '',
          'content-type': 'application/json',
        },
        body,
        idempotencyKey: stored.prepared.idempotencyKey,
      }),
    );
    const data =
      typeof response.data === 'object' && response.data !== null
        ? (response.data as Record<string, unknown>)
        : response;
    const remoteId = typeof data.item_id === 'string' ? data.item_id : null;
    if (!remoteId) throw new Error('Douyin publish response did not include item_id');

    const receipt = buildSubmissionReceipt(
      stored.prepared,
      PLATFORM,
      remoteId,
      this.#now(),
    );
    return receipt;
  }

  async poll(receipt: SubmissionReceipt): Promise<RemotePublicationStatus> {
    if (receipt.deliveryMode !== DeliveryMode.DIRECT_API) {
      return {
        state: receipt.status?.state ?? 'NEEDS_ACTION',
        remoteId: receipt.remoteId,
        url: receipt.status?.url ?? null,
        message: receipt.status?.message ?? 'Douyin publication requires user handoff',
        checkedAt: this.#now(),
      };
    }

    const account = await requireAccount(this.#accounts, receipt.accountId);
    const openId = account.credentials.openId ?? '';
    const response = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: `${API_ROOT}/api/douyin/v1/video/video_basic_info/?open_id=${encodeURIComponent(openId)}`,
        headers: {
          'access-token': account.credentials.accessToken ?? '',
          'content-type': 'application/json',
        },
        body: { item_ids: receipt.remoteId ? [receipt.remoteId] : [] },
        idempotencyKey: receipt.idempotencyKey,
      }),
    );
    const data =
      typeof response.data === 'object' && response.data !== null
        ? (response.data as { list?: Array<Record<string, unknown>> })
        : {};
    const item = data.list?.[0];
    const videoStatus =
      typeof item?.video_status === 'number' ? item.video_status : null;
    const reviewStatus =
      typeof item?.review_status === 'string'
        ? item.review_status.toUpperCase()
        : 'UNKNOWN';
    const state =
      videoStatus === 5 || videoStatus === 6 || videoStatus === 7 ||
      reviewStatus === 'PUBLISHED' || reviewStatus === 'PASS'
        ? 'PUBLISHED'
        : videoStatus === 4 ||
            reviewStatus === 'PROCESSING' || reviewStatus === 'REVIEWING'
          ? 'PROCESSING'
          : videoStatus === 2 ||
              reviewStatus === 'REJECTED' || reviewStatus === 'FAILED'
            ? 'REJECTED'
            : 'UNKNOWN';
    const videoId = typeof item?.video_id === 'string' ? item.video_id : null;

    return {
      state,
      remoteId:
        typeof item?.item_id === 'string' ? item.item_id : receipt.remoteId,
      url:
        typeof item?.share_url === 'string'
          ? item.share_url
          : videoId
            ? `https://www.douyin.com/video/${videoId}`
            : null,
      message:
        state === 'PUBLISHED'
          ? null
          : `Douyin review status ${videoStatus ?? reviewStatus}`,
      checkedAt: this.#now(),
    };
  }

  async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    this.#store.getPrepared(preparedId);
    return buildAssistedSession(preparedId, this.#now());
  }
}
