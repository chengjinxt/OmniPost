import { describe, expect, it } from 'vitest';

import {
  ContentKind,
  DeliveryMode,
  type AssistedSession,
  type ContentRevision,
  type PreparedPublication,
} from '../../domain/index.js';
import type {
  AccountConnectionSource,
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../platforms/index.js';
import {
  FetchHttpTransport,
  createLaunchAdapterRegistry,
  type AssistedFlowPort,
} from './adapter-registry.js';

const timestamp = '2026-10-12T08:00:00.000Z';
const contentHash = 'a'.repeat(64);

const revision: ContentRevision = {
  id: 'revision-1',
  contentItemId: 'content-1',
  revisionNumber: 1,
  kind: ContentKind.ARTICLE,
  title: 'Canonical platform test',
  bodyMarkdown: '# body',
  media: [],
  sourceHash: null,
  contentHash,
  createdAt: timestamp,
};

class RecordingTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return { status: 200, body: { media_id: 'draft-1' } };
  }
}

class RecordingAssistedFlow implements AssistedFlowPort {
  readonly opened: Array<{ platform: string; prepared: PreparedPublication }> = [];

  async open(input: {
    platform: 'WECHAT_OFFICIAL_ACCOUNT' | 'DOUYIN' | 'YOUTUBE' | 'ZHIHU';
    prepared: PreparedPublication;
  }): Promise<AssistedSession> {
    this.opened.push(input);
    return {
      id: 'assisted-1',
      preparedId: input.prepared.id,
      status: 'OPEN',
      openedAt: timestamp,
    };
  }
}

describe('FetchHttpTransport', () => {
  it('serializes JSON and forwards the idempotency key through the fetch boundary', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const transport = new FetchHttpTransport(async (input, init) => {
      calls.push({ input: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ remote: 'ok' }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
      });
    });

    const result = await transport.send({
      method: 'POST',
      url: 'https://example.invalid/publish',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: { title: 'hello' },
      idempotencyKey: `publish_${'b'.repeat(64)}`,
    });

    expect(calls).toEqual([
      {
        input: 'https://example.invalid/publish',
        init: expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'hello' }),
          headers: {
            authorization: 'Bearer secret',
            'content-type': 'application/json',
            'idempotency-key': `publish_${'b'.repeat(64)}`,
          },
        }),
      },
    ]);
    expect(result).toEqual({
      status: 201,
      body: { remote: 'ok' },
      headers: expect.objectContaining({ 'x-request-id': 'request-1' }),
    });
  });

  it('returns text for non-JSON responses and null for an empty response', async () => {
    const responses = [
      new Response('accepted', { status: 202, headers: { 'content-type': 'text/plain' } }),
      new Response(null, { status: 204 }),
    ];
    const transport = new FetchHttpTransport(async () => responses.shift()!);

    const textResponse = await transport.send({
      method: 'GET',
      url: 'https://example.invalid/status',
      headers: {},
      idempotencyKey: 'status-check',
    });
    const emptyResponse = await transport.send({
      method: 'DELETE',
      url: 'https://example.invalid/draft',
      headers: {},
      idempotencyKey: 'delete-draft',
    });

    expect(textResponse.body).toBe('accepted');
    expect(emptyResponse.body).toBeNull();
  });
});

describe('launch adapter registry', () => {
  it('registers exactly the four canonical launch platform IDs', () => {
    const registry = createRegistry();

    expect(registry.platforms()).toEqual([
      'WECHAT_OFFICIAL_ACCOUNT',
      'DOUYIN',
      'YOUTUBE',
      'ZHIHU',
    ]);
    expect(registry.get('WECHAT_OFFICIAL_ACCOUNT')).toBeDefined();
    expect(registry.get('wechat')).toBeUndefined();
    expect(registry.get('MEDIUM')).toBeUndefined();
  });

  it('translates a canonical target for the adapter and restores canonical output', async () => {
    const transport = new RecordingTransport();
    const registry = createRegistry({ transport });
    const adapter = registry.get('WECHAT_OFFICIAL_ACCOUNT')!;
    const target = {
      accountId: 'account-1',
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      deliveryMode: DeliveryMode.REMOTE_DRAFT,
      scheduledAt: null,
      platformFields: { bodyHtml: '<h1>body</h1>', coverMediaId: 'cover-1' },
    };

    const issues = await adapter.validate(revision.id, target);
    const prepared = await adapter.prepare(revision.id, target);
    const receipt = await adapter.submit(prepared.id);

    expect(issues).toEqual([]);
    expect(prepared.target.platform).toBe('WECHAT_OFFICIAL_ACCOUNT');
    expect(receipt.platform).toBe('WECHAT_OFFICIAL_ACCOUNT');
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects a target belonging to another canonical platform', async () => {
    const adapter = createRegistry().get('YOUTUBE')!;

    const issues = await adapter.validate(revision.id, {
      accountId: 'account-1',
      platform: 'DOUYIN',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: null,
      platformFields: {},
    });

    expect(issues).toContainEqual({
      code: 'platform-mismatch',
      message: 'Target platform must be YOUTUBE',
      severity: 'ERROR',
      field: 'platform',
    });
  });

  it('opens an injected assisted flow with canonical platform context', async () => {
    const transport = new RecordingTransport();
    const assistedFlows = new RecordingAssistedFlow();
    const adapter = createRegistry({ transport, assistedFlows }).get(
      'WECHAT_OFFICIAL_ACCOUNT',
    )!;
    const prepared = await adapter.prepare(revision.id, {
      accountId: 'account-1',
      platform: 'WECHAT_OFFICIAL_ACCOUNT',
      deliveryMode: DeliveryMode.REMOTE_DRAFT,
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>body</p>', coverMediaId: 'cover-1' },
    });

    const session = await adapter.openAssistedFlow!(prepared.id);

    expect(session.preparedId).toBe(prepared.id);
    expect(assistedFlows.opened).toEqual([
      { platform: 'WECHAT_OFFICIAL_ACCOUNT', prepared },
    ]);
  });
});

function createRegistry(overrides: {
  transport?: HttpTransport;
  assistedFlows?: AssistedFlowPort;
} = {}) {
  const accounts: AccountConnectionSource = {
    async getAccount(accountId) {
      return {
        accountId,
        credentials: { accessToken: 'token' },
        capabilityContext: {
          qualifications: [],
          scopes: ['wechat.draft', 'youtube.upload'],
          probes: {
            directApi: 'AVAILABLE',
            remoteDraft: 'AVAILABLE',
            assistedBrowser: 'AVAILABLE',
          },
        },
      };
    },
  };
  return createLaunchAdapterRegistry({
    transport: overrides.transport ?? new RecordingTransport(),
    revisions: { async getRevision(id) { return id === revision.id ? revision : null; } },
    accounts,
    now: () => timestamp,
    ...(overrides.assistedFlows ? { assistedFlows: overrides.assistedFlows } : {}),
  });
}
