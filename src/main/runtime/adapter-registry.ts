import {
  type AccountCapabilities,
  type AssistedSession,
  type ContentRevision,
  type PlatformAdapter,
  type PreparedPublication,
  type PublishTarget,
  type RemotePublicationStatus,
  type SubmissionReceipt,
  type ValidationIssue,
} from '../../domain/index.js';
import {
  DouyinAdapter,
  PlatformValidationError,
  WeChatAdapter,
  YouTubeAdapter,
  ZhihuAdapter,
  currentPlatformOperationSignal,
  type AccountConnectionSource,
  type AdapterDependencies,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type PlatformAccountRuntime,
} from '../platforms/index.js';
import type { AdapterRegistry } from '../scheduler/persistent-scheduler.js';

export const LAUNCH_PLATFORM_IDS = [
  'WECHAT_OFFICIAL_ACCOUNT',
  'DOUYIN',
  'YOUTUBE',
  'ZHIHU',
] as const;

export type LaunchPlatformId = (typeof LAUNCH_PLATFORM_IDS)[number];

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class FetchHttpTransport implements HttpTransport {
  public constructor(
    private readonly fetchImplementation: FetchLike = globalThis.fetch,
  ) {}

  public async send(request: HttpRequest): Promise<HttpResponse> {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    if (!('idempotency-key' in headers)) {
      headers['idempotency-key'] = request.idempotencyKey;
    }
    const init: RequestInit = { method: request.method, headers };
    const signal = currentPlatformOperationSignal();
    if (signal !== undefined) init.signal = signal;
    if (request.body !== undefined) {
      init.body = typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);
    }

    const response = await this.fetchImplementation(request.url, init);
    const text = await response.text();
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    let body: unknown = null;
    if (text.length > 0) {
      body = contentType.includes('application/json') ? JSON.parse(text) : text;
    }

    return {
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }
}

export interface AssistedFlowPort {
  open(input: {
    platform: LaunchPlatformId;
    prepared: PreparedPublication;
  }): Promise<AssistedSession>;
}

export interface RevisionLookup {
  getRevision(
    revisionId: string,
  ):
    | ContentRevision
    | null
    | undefined
    | Promise<ContentRevision | null | undefined>;
}

export interface AccountLookup {
  getAccount(
    accountId: string,
  ):
    | PlatformAccountRuntime
    | null
    | undefined
    | Promise<PlatformAccountRuntime | null | undefined>;
}

export interface LaunchAdapterRegistryOptions {
  transport: HttpTransport;
  revisions: RevisionLookup;
  accounts: AccountLookup;
  assistedFlows?: AssistedFlowPort;
  now?: () => string;
}

interface PlatformBinding {
  canonical: LaunchPlatformId;
  protocol: string;
  adapter: PlatformAdapter;
}

class CanonicalPlatformAdapter implements PlatformAdapter {
  readonly #prepared = new Map<string, PreparedPublication>();

  public constructor(
    private readonly binding: PlatformBinding,
    private readonly assistedFlows?: AssistedFlowPort,
  ) {}

  public async probeCapabilities(accountId: string): Promise<AccountCapabilities> {
    const capabilities = await this.binding.adapter.probeCapabilities(accountId);
    return { ...capabilities, platform: this.binding.canonical };
  }

  public async validate(
    revisionId: string,
    target: PublishTarget,
  ): Promise<ValidationIssue[]> {
    if (target.platform !== this.binding.canonical) {
      return [this.platformMismatch()];
    }
    return this.binding.adapter.validate(revisionId, this.toProtocolTarget(target));
  }

  public async prepare(
    revisionId: string,
    target: PublishTarget,
  ): Promise<PreparedPublication> {
    if (target.platform !== this.binding.canonical) {
      throw new PlatformValidationError([this.platformMismatch()]);
    }
    const protocolPrepared = await this.binding.adapter.prepare(
      revisionId,
      this.toProtocolTarget(target),
    );
    const prepared = { ...protocolPrepared, target };
    this.#prepared.set(prepared.id, prepared);
    return prepared;
  }

  public async submit(preparedId: string): Promise<SubmissionReceipt> {
    const receipt = await this.binding.adapter.submit(preparedId);
    return { ...receipt, platform: this.binding.canonical };
  }

  public async poll(
    receipt: SubmissionReceipt,
  ): Promise<RemotePublicationStatus> {
    if (!this.binding.adapter.poll) {
      throw new Error(
        `Platform ${this.binding.canonical} does not support remote status lookup`,
      );
    }
    return this.binding.adapter.poll({
      ...receipt,
      platform: this.binding.protocol,
    });
  }

  public async openAssistedFlow(preparedId: string): Promise<AssistedSession> {
    if (this.assistedFlows) {
      const prepared = this.#prepared.get(preparedId);
      if (!prepared) throw new Error(`Unknown prepared publication: ${preparedId}`);
      return this.assistedFlows.open({
        platform: this.binding.canonical,
        prepared,
      });
    }
    if (!this.binding.adapter.openAssistedFlow) {
      throw new Error(
        `Platform ${this.binding.canonical} does not provide an assisted flow`,
      );
    }
    return this.binding.adapter.openAssistedFlow(preparedId);
  }

  private toProtocolTarget(target: PublishTarget): PublishTarget {
    return { ...target, platform: this.binding.protocol };
  }

  private platformMismatch(): ValidationIssue {
    return {
      code: 'platform-mismatch',
      message: `Target platform must be ${this.binding.canonical}`,
      severity: 'ERROR',
      field: 'platform',
    };
  }
}

export class LaunchAdapterRegistry implements AdapterRegistry {
  public constructor(
    private readonly adapters: ReadonlyMap<LaunchPlatformId, PlatformAdapter>,
  ) {}

  public get(platform: string): PlatformAdapter | undefined {
    return isLaunchPlatformId(platform) ? this.adapters.get(platform) : undefined;
  }

  public platforms(): LaunchPlatformId[] {
    return LAUNCH_PLATFORM_IDS.filter((platform) => this.adapters.has(platform));
  }
}

export function createLaunchAdapterRegistry(
  options: LaunchAdapterRegistryOptions,
): LaunchAdapterRegistry {
  const revisions: AdapterDependencies['revisions'] = {
    async getRevision(revisionId) {
      return (await options.revisions.getRevision(revisionId)) ?? null;
    },
  };
  const accounts: AccountConnectionSource = {
    async getAccount(accountId) {
      return (await options.accounts.getAccount(accountId)) ?? null;
    },
  };
  const dependencies: AdapterDependencies = {
    transport: options.transport,
    revisions,
    accounts,
    ...(options.now ? { now: options.now } : {}),
  };
  const raw = new Map<LaunchPlatformId, PlatformBinding>([
    [
      'WECHAT_OFFICIAL_ACCOUNT',
      {
        canonical: 'WECHAT_OFFICIAL_ACCOUNT',
        protocol: 'wechat',
        adapter: new WeChatAdapter(dependencies),
      },
    ],
    [
      'DOUYIN',
      {
        canonical: 'DOUYIN',
        protocol: 'douyin',
        adapter: new DouyinAdapter(dependencies),
      },
    ],
    [
      'YOUTUBE',
      {
        canonical: 'YOUTUBE',
        protocol: 'youtube',
        adapter: new YouTubeAdapter(dependencies),
      },
    ],
    [
      'ZHIHU',
      {
        canonical: 'ZHIHU',
        protocol: 'zhihu',
        adapter: new ZhihuAdapter(dependencies),
      },
    ],
  ]);
  return new LaunchAdapterRegistry(
    new Map(
      [...raw.entries()].map(([platform, binding]) => [
        platform,
        new CanonicalPlatformAdapter(binding, options.assistedFlows),
      ]),
    ),
  );
}

function isLaunchPlatformId(platform: string): platform is LaunchPlatformId {
  return (LAUNCH_PLATFORM_IDS as readonly string[]).includes(platform);
}
