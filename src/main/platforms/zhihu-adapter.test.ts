import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ContentKind, DeliveryMode } from '../../domain/index.js';
import {
  type AccountConnectionSource,
  type ContentRevisionSource,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './adapter-runtime.js';
import { ZhihuAdapter } from './zhihu-adapter.js';

const NOW = '2026-10-12T04:00:00.000Z';
const CONTENT_HASH = 'd'.repeat(64);

class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly #responses: HttpResponse[];

  constructor(...responses: HttpResponse[]) {
    this.#responses = responses;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) throw new Error(`Unexpected request: ${request.url}`);
    return response;
  }
}

function revisionSource(kind: 'ARTICLE' | 'IMAGE_POST' | 'VIDEO'): ContentRevisionSource {
  return {
    async getRevision(revisionId) {
      if (revisionId !== 'revision-1') return null;
      return {
        id: 'revision-1',
        contentItemId: 'content-1',
        revisionNumber: 1,
        kind,
        title: 'OmniPost 架构说明',
        bodyMarkdown: '正文',
        media: [],
        sourceHash: null,
        contentHash: CONTENT_HASH,
        createdAt: NOW,
      };
    },
  };
}

function accountSource(hasPermission: boolean): AccountConnectionSource {
  return {
    async getAccount(accountId) {
      if (accountId !== 'zhihu-account') return null;
      return {
        accountId,
        credentials: {
          appKey: 'zhihu-member-token',
          appSecret: 'zhihu-test-secret',
        },
        capabilityContext: {
          qualifications: hasPermission ? ['ZHIHU_PUBLISHER_ACCESS'] : [],
          scopes: hasPermission ? ['zhihu.publish'] : [],
          probes: {
            directApi: hasPermission ? 'AVAILABLE' : 'UNAVAILABLE',
            remoteDraft: 'UNAVAILABLE',
            assistedBrowser: 'AVAILABLE',
          },
        },
      };
    },
  };
}

describe('ZhihuAdapter', () => {
  it('signs a confirmed article request and maps the immediate publish result', async () => {
    const transport = new FakeTransport({
      status: 200,
      body: {
        status: 0,
        msg: 'success',
        data: {
          type: 'article',
          content_token: 'zhihu-content-1',
          url: 'https://zhuanlan.zhihu.com/p/123456',
        },
      },
    });
    const adapter = new ZhihuAdapter({
      transport,
      revisions: revisionSource(ContentKind.ARTICLE),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'zhihu-account',
      platform: 'zhihu',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: null,
      platformFields: {
        title: '知乎平台版本标题',
        bodyHtml: '<p>正文</p>',
        userConfirmed: true,
        commentPermission: 'all',
        tableOfContentsEnabled: false,
        creationStatement: 'ai_creation',
        topicTokens: ['19555547'],
      },
    };

    expect(await adapter.validate('revision-1', target)).toEqual([]);
    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);
    const logId = `omnipost-${prepared.idempotencyKey.slice('publish_'.length, 40)}`;
    const timestamp = '1791777600';
    const signString =
      `app_key:zhihu-member-token|ts:${timestamp}|logid:${logId}|extra_info:`;
    const signature = createHmac('sha256', 'zhihu-test-secret')
      .update(signString, 'utf8')
      .digest('base64');

    expect(transport.requests[0]).toEqual({
      method: 'POST',
      url: 'https://openapi.zhihu.com/openapi/publish',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': 'zhihu-member-token',
        'X-Timestamp': timestamp,
        'X-Log-Id': logId,
        'X-Extra-Info': '',
        'X-Sign': signature,
      },
      body: {
        type: 'article',
        confirmed: true,
        confirm_note: 'confirmed by user after local preview',
        content: {
          title: '知乎平台版本标题',
          html: '<p>正文</p>',
          comment_permission: 'all',
          table_of_contents_enabled: false,
          creation_statement: 'ai_creation',
          topics: [
            { topic_id: '', topic_token: '19555547', topic_name: '' },
          ],
        },
      },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(JSON.stringify(transport.requests[0])).not.toContain('zhihu-test-secret');
    expect(receipt.remoteId).toBe('zhihu-content-1');
    expect(receipt).toMatchObject({
      accountId: 'zhihu-account',
      deliveryMode: DeliveryMode.DIRECT_API,
      idempotencyKey: prepared.idempotencyKey,
    });
    const restartedAdapter = new ZhihuAdapter({
      transport,
      revisions: revisionSource(ContentKind.ARTICLE),
      accounts: accountSource(true),
      now: () => NOW,
    });
    expect(await restartedAdapter.poll(receipt)).toMatchObject({
      state: 'PUBLISHED',
      remoteId: 'zhihu-content-1',
      url: 'https://zhuanlan.zhihu.com/p/123456',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('never offers or submits video through the experimental publisher', async () => {
    const transport = new FakeTransport();
    const adapter = new ZhihuAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'zhihu-account',
      platform: 'zhihu',
      deliveryMode: DeliveryMode.UNSUPPORTED,
      scheduledAt: null,
      platformFields: {},
    };

    const capabilities = await adapter.probeCapabilities('zhihu-account');
    expect(capabilities.contentKinds).toEqual([
      ContentKind.ARTICLE,
      ContentKind.IMAGE_POST,
    ]);
    expect(await adapter.validate('revision-1', target)).toContainEqual(
      expect.objectContaining({ code: 'content-kind-unsupported' }),
    );
    await expect(adapter.prepare('revision-1', target)).rejects.toMatchObject({
      name: 'PlatformValidationError',
    });
    expect(transport.requests).toEqual([]);
  });

  it('degrades to manual handoff when publisher access is unavailable', async () => {
    const transport = new FakeTransport();
    const adapter = new ZhihuAdapter({
      transport,
      revisions: revisionSource(ContentKind.ARTICLE),
      accounts: accountSource(false),
      now: () => NOW,
    });
    const target = {
      accountId: 'zhihu-account',
      platform: 'zhihu',
      deliveryMode: DeliveryMode.MANUAL_HANDOFF,
      scheduledAt: null,
      platformFields: { bodyHtml: '<p>正文</p>' },
    };

    expect((await adapter.probeCapabilities('zhihu-account')).deliveryModes).toEqual([
      DeliveryMode.MANUAL_HANDOFF,
    ]);
    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);
    expect(transport.requests).toEqual([]);
    expect(receipt.remoteId).toBeNull();
    expect(await adapter.poll(receipt)).toMatchObject({ state: 'NEEDS_ACTION' });
    expect(await adapter.openAssistedFlow(prepared.id)).toMatchObject({ status: 'OPEN' });
  });
});
