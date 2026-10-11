import { createHmac } from 'node:crypto';

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
  type SubmissionStatusMetadata,
  type ValidationIssue,
} from '../../domain/index.js';
import { resolvePlatformCapability } from './capability-registry.js';
import {
  AdapterRuntimeStore,
  PlatformValidationError,
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
  stringArrayField,
  stringField,
  validationIssue,
  type AdapterDependencies,
} from './adapter-runtime.js';

interface ZhihuPayload {
  type: 'article' | 'pin';
  confirmed: true;
  confirm_note: string;
  content: Record<string, unknown>;
}

const PLATFORM = 'zhihu';
const PUBLISH_URL = 'https://openapi.zhihu.com/openapi/publish';

export class ZhihuAdapter implements PlatformAdapter {
  readonly #transport: AdapterDependencies['transport'];
  readonly #revisions: AdapterDependencies['revisions'];
  readonly #accounts: AdapterDependencies['accounts'];
  readonly #now: () => string;
  readonly #store = new AdapterRuntimeStore<ZhihuPayload>();

  constructor(dependencies: AdapterDependencies) {
    this.#transport = dependencies.transport;
    this.#revisions = dependencies.revisions;
    this.#accounts = dependencies.accounts;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    const account = await requireAccount(this.#accounts, accountId);
    const deliveryModes = [ContentKind.ARTICLE, ContentKind.IMAGE_POST].map(
      (contentKind) =>
        resolvePlatformCapability({
          platform: 'ZHIHU',
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
      contentKinds: [ContentKind.ARTICLE, ContentKind.IMAGE_POST],
      qualificationLabels: {
        ZHIHU_PUBLISHER_ACCESS: 'Zhihu Publisher test-list access',
      },
      scopeNames: ['zhihu.publish'],
      supportsDrafts: false,
      supportsScheduling: false,
      supportsRemoteStatus: false,
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
    if (!account) return [validationIssue('account-not-found', 'Zhihu account not found')];
    if (target.platform !== PLATFORM) {
      issues.push(validationIssue('platform-mismatch', 'Target platform must be zhihu'));
    }
    if (revision.kind !== ContentKind.ARTICLE && revision.kind !== ContentKind.IMAGE_POST) {
      issues.push(
        validationIssue(
          'content-kind-unsupported',
          'Zhihu Publisher currently supports articles and image posts, not video',
        ),
      );
      return issues;
    }

    const resolved = resolvePlatformCapability({
      platform: 'ZHIHU',
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
    if (!stringField(target.platformFields, 'bodyHtml')) {
      issues.push(validationIssue('body-html-required', 'Rendered HTML is required', 'bodyHtml'));
    }
    if (target.scheduledAt) {
      issues.push(
        validationIssue(
          'scheduling-unsupported',
          'Zhihu Publisher does not support scheduled publication',
          'scheduledAt',
        ),
      );
    }
    if (target.deliveryMode === DeliveryMode.DIRECT_API) {
      if (booleanField(target.platformFields, 'userConfirmed') !== true) {
        issues.push(
          validationIssue(
            'confirmation-required',
            'User confirmation after preview is required',
            'userConfirmed',
          ),
        );
      }
      if (!account.credentials.appKey || !account.credentials.appSecret) {
        issues.push(
          validationIssue(
            'credential-missing',
            'Zhihu OpenAPI app key and app secret are required',
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
    const content: Record<string, unknown> = {
      title: stringField(target.platformFields, 'title') ?? revision.title,
      html: stringField(target.platformFields, 'bodyHtml') ?? '',
      comment_permission:
        stringField(target.platformFields, 'commentPermission') ?? 'all',
    };

    if (revision.kind === ContentKind.ARTICLE) {
      content.table_of_contents_enabled =
        booleanField(target.platformFields, 'tableOfContentsEnabled') ?? false;
      const creationStatement = stringField(
        target.platformFields,
        'creationStatement',
      );
      if (creationStatement) content.creation_statement = creationStatement;
      const topicTokens = stringArrayField(target.platformFields, 'topicTokens');
      if (topicTokens.length > 0) {
        content.topics = topicTokens.map((topicToken) => ({
          topic_id: '',
          topic_token: topicToken,
          topic_name: '',
        }));
      }
    } else {
      const imageUrls = stringArrayField(target.platformFields, 'imageUrls');
      if (imageUrls.length > 0) {
        content.images = imageUrls.map((url) => ({ url }));
      }
      if (stringField(target.platformFields, 'creationStatement') === 'ai_creation') {
        content.creation_statement = 'ai_creation';
      }
    }

    this.#store.savePrepared({
      prepared,
      revision,
      account,
      payload: {
        type: revision.kind === ContentKind.ARTICLE ? 'article' : 'pin',
        confirmed: true,
        confirm_note: 'confirmed by user after local preview',
        content,
      },
      remoteDraftId: null,
    });
    return prepared;
  }

  async submit(preparedId: string): Promise<SubmissionReceipt> {
    const stored = this.#store.getPrepared(preparedId);
    const submittedAt = this.#now();
    if (stored.prepared.target.deliveryMode !== DeliveryMode.DIRECT_API) {
      const receipt = buildSubmissionReceipt(
        stored.prepared,
        PLATFORM,
        null,
        submittedAt,
        {
          state: 'NEEDS_ACTION',
          url: null,
          message: 'Zhihu publication requires user handoff',
        },
      );
      return receipt;
    }

    const appKey = stored.account.credentials.appKey ?? '';
    const appSecret = stored.account.credentials.appSecret ?? '';
    const timestamp = String(Math.floor(Date.parse(submittedAt) / 1000));
    const logId = `omnipost-${stored.prepared.idempotencyKey.slice('publish_'.length, 40)}`;
    const extraInfo = stored.account.credentials.extraInfo ?? '';
    const signString =
      `app_key:${appKey}|ts:${timestamp}|logid:${logId}|extra_info:${extraInfo}`;
    const signature = createHmac('sha256', appSecret)
      .update(signString, 'utf8')
      .digest('base64');
    const response = responseObject(
      await this.#transport.send({
        method: 'POST',
        url: PUBLISH_URL,
        headers: {
          'Content-Type': 'application/json',
          'X-App-Key': appKey,
          'X-Timestamp': timestamp,
          'X-Log-Id': logId,
          'X-Extra-Info': extraInfo,
          'X-Sign': signature,
        },
        body: stored.payload,
        idempotencyKey: stored.prepared.idempotencyKey,
      }),
    );
    const data =
      typeof response.data === 'object' && response.data !== null
        ? (response.data as Record<string, unknown>)
        : {};
    const succeeded = response.status === 0;
    const remoteId =
      succeeded && typeof data.content_token === 'string'
        ? data.content_token
        : null;
    const url = succeeded && typeof data.url === 'string' ? data.url : null;
    const message = typeof response.msg === 'string' ? response.msg : null;
    const status: SubmissionStatusMetadata = {
      state: succeeded ? 'PUBLISHED' : 'REJECTED',
      url,
      message: succeeded ? null : message ?? 'Zhihu rejected the publication',
    };
    return buildSubmissionReceipt(
      stored.prepared,
      PLATFORM,
      remoteId,
      submittedAt,
      status,
    );
  }

  async poll(receipt: SubmissionReceipt): Promise<RemotePublicationStatus> {
    await requireAccount(this.#accounts, receipt.accountId);
    return {
      state: receipt.status?.state ?? 'UNKNOWN',
      remoteId: receipt.remoteId,
      url: receipt.status?.url ?? null,
      message: receipt.status?.message ?? 'Zhihu receipt does not contain a terminal status',
      checkedAt: this.#now(),
    };
  }

  async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    this.#store.getPrepared(preparedId);
    return buildAssistedSession(preparedId, this.#now());
  }
}
