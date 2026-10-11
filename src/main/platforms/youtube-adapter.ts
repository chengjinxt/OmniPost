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

interface YouTubePayload {
  title: string;
  uploadUri: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: string;
}

const PLATFORM = 'youtube';
const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_ROOT = 'https://www.googleapis.com/upload/youtube/v3';

export class YouTubeAdapter implements PlatformAdapter {
  readonly #transport: AdapterDependencies['transport'];
  readonly #revisions: AdapterDependencies['revisions'];
  readonly #accounts: AdapterDependencies['accounts'];
  readonly #now: () => string;
  readonly #store = new AdapterRuntimeStore<YouTubePayload>();

  constructor(dependencies: AdapterDependencies) {
    this.#transport = dependencies.transport;
    this.#revisions = dependencies.revisions;
    this.#accounts = dependencies.accounts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    const account = await requireAccount(this.#accounts, accountId);
    const deliveryMode = resolvePlatformCapability({
      platform: 'YOUTUBE',
      contentKind: ContentKind.VIDEO,
      context: account.capabilityContext,
    }).deliveryMode;

    return capabilitiesFromContext({
      accountId,
      platform: PLATFORM,
      context: account.capabilityContext,
      deliveryModes: deliveryModesWithAssistedBrowser(
        [deliveryMode],
        account.capabilityContext.probes,
      ),
      contentKinds: [ContentKind.VIDEO],
      qualificationLabels: {},
      scopeNames: ['youtube.upload'],
      supportsDrafts: false,
      supportsScheduling: deliveryMode === DeliveryMode.DIRECT_API,
      supportsRemoteStatus: deliveryMode === DeliveryMode.DIRECT_API,
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
    if (!account) return [validationIssue('account-not-found', 'YouTube account not found')];
    if (target.platform !== PLATFORM) {
      issues.push(validationIssue('platform-mismatch', 'Target platform must be youtube'));
    }
    if (revision.kind !== ContentKind.VIDEO) {
      issues.push(
        validationIssue(
          'content-kind-unsupported',
          'YouTube adapter supports video content only',
        ),
      );
      return issues;
    }

    const resolved = resolvePlatformCapability({
      platform: 'YOUTUBE',
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
    if (!stringField(target.platformFields, 'uploadUri')) {
      issues.push(
        validationIssue('upload-uri-required', 'YouTube upload URI is required', 'uploadUri'),
      );
    }
    if (target.deliveryMode === DeliveryMode.DIRECT_API && !account.credentials.accessToken) {
      issues.push(validationIssue('credential-missing', 'YouTube OAuth token is required'));
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
        title: stringField(target.platformFields, 'title') ?? revision.title,
        uploadUri: stringField(target.platformFields, 'uploadUri') ?? '',
        description:
          stringField(target.platformFields, 'description') ??
          stringField(target.platformFields, 'bodyMarkdown') ??
          revision.bodyMarkdown,
        tags: stringArrayField(target.platformFields, 'tags'),
        categoryId: stringField(target.platformFields, 'categoryId') ?? '22',
        privacyStatus:
          stringField(target.platformFields, 'privacyStatus') ?? 'private',
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
          message: 'YouTube upload requires user handoff',
        },
      );
      return receipt;
    }

    const scheduledAt = stored.prepared.target.scheduledAt;
    const status = scheduledAt
      ? { privacyStatus: 'private', publishAt: scheduledAt }
      : { privacyStatus: stored.payload.privacyStatus };
    const response = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: `${UPLOAD_ROOT}/videos?part=snippet%2Cstatus&uploadType=multipart`,
        headers: {
          authorization: `Bearer ${stored.account.credentials.accessToken ?? ''}`,
          'content-type': 'application/json',
        },
        body: {
          metadata: {
            snippet: {
              title: stored.payload.title,
              description: stored.payload.description,
              tags: stored.payload.tags,
              categoryId: stored.payload.categoryId,
            },
            status,
          },
          media: { uri: stored.payload.uploadUri },
        },
        idempotencyKey: stored.prepared.idempotencyKey,
      }),
    );
    const remoteId = typeof response.id === 'string' ? response.id : null;
    if (!remoteId) throw new Error('YouTube upload response did not include id');

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
        message: receipt.status?.message ?? 'YouTube upload requires user handoff',
        checkedAt: this.#now(),
      };
    }

    const account = await requireAccount(this.#accounts, receipt.accountId);
    const response = responseObject(
      await this.#transport.send({
        method: 'GET',
        url: `${API_ROOT}/videos?part=processingDetails%2Cstatus&id=${encodeURIComponent(receipt.remoteId ?? '')}`,
        headers: {
          authorization: `Bearer ${account.credentials.accessToken ?? ''}`,
        },
        idempotencyKey: receipt.idempotencyKey,
      }),
    );
    const items = Array.isArray(response.items)
      ? (response.items as Array<Record<string, unknown>>)
      : [];
    const item = items[0];
    const details =
      typeof item?.processingDetails === 'object' && item.processingDetails !== null
        ? (item.processingDetails as Record<string, unknown>)
        : {};
    const processingStatus =
      typeof details.processingStatus === 'string'
        ? details.processingStatus.toLowerCase()
        : 'unknown';
    const state =
      processingStatus === 'succeeded'
        ? 'PUBLISHED'
        : processingStatus === 'processing'
          ? 'PROCESSING'
          : processingStatus === 'failed' || processingStatus === 'terminated'
            ? 'FAILED'
            : 'UNKNOWN';
    const remoteId = typeof item?.id === 'string' ? item.id : receipt.remoteId;

    return {
      state,
      remoteId,
      url: remoteId ? `https://www.youtube.com/watch?v=${remoteId}` : null,
      message: state === 'PUBLISHED' ? null : `YouTube processing status ${processingStatus}`,
      checkedAt: this.#now(),
    };
  }

  async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    this.#store.getPrepared(preparedId);
    return buildAssistedSession(preparedId, this.#now());
  }
}
