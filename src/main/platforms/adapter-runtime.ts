import {
  DeliveryMode,
  Sha256Schema,
  createPublishIdempotencyKey,
  type AccountCapabilities,
  type AssistedSession,
  type ContentRevision,
  type JsonObject,
  type JsonValue,
  type PreparedPublication,
  type PublishTarget,
  type SubmissionReceipt,
  type SubmissionStatusMetadata,
  type ValidationIssue,
} from '../../domain/index.js';
import type { CapabilityContext } from './capability-registry.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  idempotencyKey: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export interface PlatformAccountRuntime {
  accountId: string;
  credentials: Readonly<Record<string, string>>;
  capabilityContext: CapabilityContext;
}

export interface AccountConnectionSource {
  getAccount(accountId: string): Promise<PlatformAccountRuntime | null>;
}

export interface ContentRevisionSource {
  getRevision(revisionId: string): Promise<ContentRevision | null>;
}

export interface AdapterDependencies {
  transport: HttpTransport;
  revisions: ContentRevisionSource;
  accounts: AccountConnectionSource;
  now?: () => string;
}

export interface StoredPreparedPublication<Payload = unknown> {
  prepared: PreparedPublication;
  revision: ContentRevision;
  account: PlatformAccountRuntime;
  payload: Payload;
  remoteDraftId: string | null;
}

export class AdapterRuntimeStore<Payload = unknown> {
  readonly #prepared = new Map<string, StoredPreparedPublication<Payload>>();

  savePrepared(value: StoredPreparedPublication<Payload>): void {
    this.#prepared.set(value.prepared.id, value);
  }

  getPrepared(preparedId: string): StoredPreparedPublication<Payload> {
    const value = this.#prepared.get(preparedId);
    if (!value) throw new Error(`Unknown prepared publication: ${preparedId}`);
    return value;
  }
}

export class PlatformValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'PlatformValidationError';
  }
}

export function validationIssue(
  code: string,
  message: string,
  field: string | null = null,
): ValidationIssue {
  return { code, message, severity: 'ERROR', field };
}

export function jsonField(
  fields: JsonObject,
  name: string,
): JsonValue | undefined {
  return fields[name];
}

export function stringField(fields: JsonObject, name: string): string | null {
  const value = jsonField(fields, name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function stringArrayField(fields: JsonObject, name: string): string[] {
  const value = jsonField(fields, name);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function booleanField(fields: JsonObject, name: string): boolean | null {
  const value = jsonField(fields, name);
  return typeof value === 'boolean' ? value : null;
}

export function deliveryModesWithAssistedBrowser(
  modes: readonly PublishTarget['deliveryMode'][],
  probes: CapabilityContext['probes'],
): PublishTarget['deliveryMode'][] {
  return [...new Set([
    ...modes,
    ...(probes.assistedBrowser === 'AVAILABLE'
      ? [DeliveryMode.ASSISTED_BROWSER]
      : []),
  ])];
}

export function isCompatibleDeliveryMode(
  resolved: PublishTarget['deliveryMode'],
  requested: PublishTarget['deliveryMode'],
): boolean {
  return requested === DeliveryMode.ASSISTED_BROWSER ||
    requested === DeliveryMode.MANUAL_HANDOFF ||
    requested === resolved;
}

export function buildPreparedPublication(
  revision: ContentRevision,
  target: PublishTarget,
  createdAt: string,
): PreparedPublication {
  const boundContentHash = Sha256Schema.safeParse(
    target.platformFields.__omniPostContentHash,
  );
  const contentHash = boundContentHash.success
    ? boundContentHash.data
    : revision.contentHash;
  const idempotencyKey = createPublishIdempotencyKey({
    accountId: target.accountId,
    platform: target.platform,
    deliveryMode: target.deliveryMode,
    contentHash,
    scheduledAt: target.scheduledAt,
    platformFields: target.platformFields,
  });

  return {
    id: `prepared-${idempotencyKey.slice('publish_'.length, 'publish_'.length + 24)}`,
    revisionId: revision.id,
    target,
    contentHash,
    idempotencyKey,
    createdAt,
  };
}

export function buildSubmissionReceipt(
  prepared: PreparedPublication,
  platform: string,
  remoteId: string | null,
  submittedAt: string,
  status: SubmissionStatusMetadata | null = null,
): SubmissionReceipt {
  return {
    id: `receipt-${prepared.id.slice('prepared-'.length)}`,
    preparedId: prepared.id,
    platform,
    accountId: prepared.target.accountId,
    deliveryMode: prepared.target.deliveryMode,
    idempotencyKey: prepared.idempotencyKey,
    remoteId,
    status,
    submittedAt,
  };
}

export function buildAssistedSession(
  preparedId: string,
  openedAt: string,
): AssistedSession {
  return {
    id: `assisted-${preparedId.slice('prepared-'.length)}`,
    preparedId,
    status: 'OPEN',
    openedAt,
  };
}

export function capabilitiesFromContext(input: {
  accountId: string;
  platform: string;
  context: CapabilityContext;
  deliveryModes: AccountCapabilities['deliveryModes'];
  contentKinds: AccountCapabilities['contentKinds'];
  qualificationLabels: Readonly<Record<string, string>>;
  scopeNames: readonly string[];
  supportsDrafts: boolean;
  supportsScheduling: boolean;
  supportsRemoteStatus: boolean;
  checkedAt: string;
}): AccountCapabilities {
  return {
    accountId: input.accountId,
    platform: input.platform,
    deliveryModes: [...new Set(input.deliveryModes)],
    contentKinds: [...new Set(input.contentKinds)],
    features: {
      supportsDrafts: input.supportsDrafts,
      supportsScheduling: input.supportsScheduling,
      supportsRemoteStatus: input.supportsRemoteStatus,
    },
    qualifications: Object.entries(input.qualificationLabels).map(
      ([code, label]) => ({
        code,
        label,
        status: input.context.qualifications.includes(code)
          ? 'SATISFIED'
          : 'MISSING',
        details: null,
      }),
    ),
    scopes: [
      ...new Set([...input.scopeNames, ...input.context.scopes]),
    ].map((name) => ({
      name,
      granted: input.context.scopes.includes(name),
    })),
    probes: [
      {
        code: 'direct-api',
        status:
          input.context.probes.directApi === 'AVAILABLE'
            ? 'PASS'
            : input.context.probes.directApi === 'UNAVAILABLE'
              ? 'FAIL'
              : 'UNKNOWN',
        message: null,
      },
      {
        code: 'remote-draft',
        status:
          input.context.probes.remoteDraft === 'AVAILABLE'
            ? 'PASS'
            : input.context.probes.remoteDraft === 'UNAVAILABLE'
              ? 'FAIL'
              : 'UNKNOWN',
        message: null,
      },
      {
        code: 'assisted-browser',
        status:
          input.context.probes.assistedBrowser === 'AVAILABLE'
            ? 'PASS'
            : input.context.probes.assistedBrowser === 'UNAVAILABLE'
              ? 'FAIL'
              : 'UNKNOWN',
        message: null,
      },
    ],
    checkedAt: input.checkedAt,
  };
}

export function responseObject(response: HttpResponse): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Platform HTTP request failed with status ${response.status}`);
  }
  if (typeof response.body !== 'object' || response.body === null) {
    throw new Error('Platform HTTP response body must be an object');
  }
  return response.body as Record<string, unknown>;
}

export async function requireRevision(
  source: ContentRevisionSource,
  revisionId: string,
): Promise<ContentRevision> {
  const revision = await source.getRevision(revisionId);
  if (!revision) throw new Error(`Unknown content revision: ${revisionId}`);
  return revision;
}

export async function requireAccount(
  source: AccountConnectionSource,
  accountId: string,
): Promise<PlatformAccountRuntime> {
  const account = await source.getAccount(accountId);
  if (!account) throw new Error(`Unknown platform account: ${accountId}`);
  return account;
}
