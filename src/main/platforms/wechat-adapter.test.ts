import { describe, expect, it, vi } from 'vitest';

import { ContentKind, DeliveryMode } from '../../domain/index.js';
import {
  type AccountConnectionSource,
  type ContentRevisionSource,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  runPlatformOperationWithSignal,
} from './adapter-runtime.js';
import { WeChatAdapter } from './wechat-adapter.js';

const NOW = '2026-10-12T03:00:00.000Z';
const CONTENT_HASH = 'a'.repeat(64);

class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private readonly responses: HttpResponse[];

  constructor(...responses: HttpResponse[]) {
    this.responses = responses;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    }
    return response;
  }
}

const revisionSource: ContentRevisionSource = {
  async getRevision(revisionId) {
    if (revisionId !== 'revision-1') return null;
    return {
      id: 'revision-1',
      contentItemId: 'content-1',
      revisionNumber: 1,
      kind: ContentKind.ARTICLE,
      title: 'Canonical title',
      bodyMarkdown: 'Canonical body',
      media: [],
      sourceHash: null,
      contentHash: CONTENT_HASH,
      createdAt: NOW,
    };
  },
};

function createAccountSource(verified: boolean, bindingVersion = 1): AccountConnectionSource {
  return {
    async getAccount(accountId) {
      if (accountId !== 'wechat-account') return null;
      return {
        accountId,
        bindingVersion,
        credentials: { accessToken: 'wechat-test-token' },
        capabilityContext: {
          qualifications: verified ? ['WECHAT_VERIFIED_ENTERPRISE'] : [],
          scopes: verified
            ? ['wechat.freepublish', 'wechat.draft']
            : ['wechat.draft'],
          probes: {
            directApi: verified ? 'AVAILABLE' : 'UNAVAILABLE',
            remoteDraft: 'AVAILABLE',
            assistedBrowser: 'AVAILABLE',
          },
        },
      };
    },
  };
}

const directTarget = {
  accountId: 'wechat-account',
  platform: 'wechat',
  deliveryMode: DeliveryMode.DIRECT_API,
  scheduledAt: null,
  platformFields: {
    title: 'WeChat variant title',
    author: 'OmniPost',
    digest: 'Digest',
    bodyHtml: '<p>Canonical body</p>',
    coverMediaId: 'cover-media-1',
    contentSourceUrl: 'https://example.com/source',
  },
};

describe('WeChatAdapter', () => {
  it('creates a remote draft, submits it, and maps the publish status', async () => {
    const transport = new FakeTransport(
      { status: 200, body: { media_id: 'draft-media-1' } },
      { status: 200, body: { publish_id: 'publish-task-1' } },
      {
        status: 200,
        body: {
          publish_status: 0,
          article_id: 'article-1',
          article_detail: { item: [{ article_url: 'https://mp.weixin.qq.com/s/1' }] },
        },
      },
    );
    const adapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(true),
      now: () => NOW,
    });

    expect(await adapter.validate('revision-1', directTarget)).toEqual([]);

    const prepared = await adapter.prepare('revision-1', directTarget);
    expect(transport.requests).toEqual([]);
    const receipt = await adapter.submit(prepared.id);
    expect(transport.requests[0]).toEqual({
      method: 'POST',
      url: 'https://api.weixin.qq.com/cgi-bin/draft/add?access_token=wechat-test-token',
      headers: { 'content-type': 'application/json' },
      body: {
        articles: [
          {
            title: 'WeChat variant title',
            author: 'OmniPost',
            digest: 'Digest',
            content: '<p>Canonical body</p>',
            content_source_url: 'https://example.com/source',
            thumb_media_id: 'cover-media-1',
            need_open_comment: 0,
            only_fans_can_comment: 0,
          },
        ],
      },
      idempotencyKey: prepared.idempotencyKey,
    });

    expect(transport.requests[1]).toEqual({
      method: 'POST',
      url: 'https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=wechat-test-token',
      headers: { 'content-type': 'application/json' },
      body: { media_id: 'draft-media-1' },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(receipt.remoteId).toBe('publish-task-1');
    expect(receipt).toMatchObject({
      accountId: 'wechat-account',
      deliveryMode: DeliveryMode.DIRECT_API,
      idempotencyKey: prepared.idempotencyKey,
    });

    const restartedAdapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(true),
      now: () => NOW,
    });
    const status = await restartedAdapter.poll(receipt);
    expect(transport.requests[2]).toEqual({
      method: 'POST',
      url: 'https://api.weixin.qq.com/cgi-bin/freepublish/get?access_token=wechat-test-token',
      headers: { 'content-type': 'application/json' },
      body: { publish_id: 'publish-task-1' },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(status).toMatchObject({
      state: 'PUBLISHED',
      remoteId: 'article-1',
      url: 'https://mp.weixin.qq.com/s/1',
    });
  });

  it('degrades an unverified account to a remote draft without calling freepublish', async () => {
    const transport = new FakeTransport({
      status: 200,
      body: { media_id: 'draft-media-1' },
    });
    const adapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(false),
      now: () => NOW,
    });
    const target = {
      ...directTarget,
      deliveryMode: DeliveryMode.REMOTE_DRAFT,
    };

    const capabilities = await adapter.probeCapabilities('wechat-account');
    expect(capabilities.deliveryModes).toContain(DeliveryMode.REMOTE_DRAFT);
    expect(capabilities.deliveryModes).not.toContain(DeliveryMode.DIRECT_API);

    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);
    const status = await adapter.poll(receipt);

    expect(transport.requests).toHaveLength(1);
    expect(receipt.remoteId).toBe('draft-media-1');
    expect(status).toMatchObject({
      state: 'NEEDS_ACTION',
      message: 'Remote draft requires user publication',
    });
    expect(await adapter.openAssistedFlow(prepared.id)).toMatchObject({
      preparedId: prepared.id,
      status: 'OPEN',
    });
  });

  it('does not continue from draft creation to publication after cancellation', async () => {
    let releaseDraft!: (value: HttpResponse) => void;
    const firstResponse = new Promise<HttpResponse>((resolve) => { releaseDraft = resolve; });
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request);
        if (requests.length > 1) throw new Error('freepublish must not be called after cancellation');
        return firstResponse;
      },
    };
    const adapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(true),
      now: () => NOW,
    });
    const prepared = await adapter.prepare('revision-1', directTarget);
    const controller = new AbortController();
    const submission = runPlatformOperationWithSignal(
      controller.signal,
      () => adapter.submit(prepared.id),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    controller.abort(new Error('scheduler deadline reached'));
    releaseDraft({ status: 200, body: { media_id: 'draft-created-after-timeout' } });

    await expect(submission).rejects.toThrow(/scheduler deadline reached|aborted/i);
    expect(requests).toHaveLength(1);
  });

  it('prepares an assisted browser handoff without calling the draft API', async () => {
    const transport = new FakeTransport();
    const adapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(false),
      now: () => NOW,
    });
    const target = {
      ...directTarget,
      deliveryMode: DeliveryMode.ASSISTED_BROWSER,
      platformFields: {
        title: 'Visible browser title',
        bodyHtml: '<p>Visible browser body</p>',
      },
    };

    expect((await adapter.probeCapabilities('wechat-account')).deliveryModes)
      .toContain(DeliveryMode.ASSISTED_BROWSER);
    expect(await adapter.validate('revision-1', target)).toEqual([]);
    const prepared = await adapter.prepare('revision-1', target);

    expect(transport.requests).toEqual([]);
    expect(await adapter.openAssistedFlow(prepared.id)).toMatchObject({
      preparedId: prepared.id,
      status: 'OPEN',
    });
  });

  it('rejects a plan after the bound account credentials have changed', async () => {
    const transport = new FakeTransport();
    const adapter = new WeChatAdapter({
      transport,
      revisions: revisionSource,
      accounts: createAccountSource(true, 2),
      now: () => NOW,
    });
    const target = {
      ...directTarget,
      platformFields: {
        ...directTarget.platformFields,
        __omniPostAccountBindingVersion: 1,
      },
    };

    expect(await adapter.validate('revision-1', target)).toContainEqual(
      expect.objectContaining({ code: 'account-binding-changed' }),
    );
    await expect(adapter.prepare('revision-1', target)).rejects.toMatchObject({
      name: 'PlatformValidationError',
    });
    expect(transport.requests).toEqual([]);
  });

  it('rejects video content before creating a remote draft', async () => {
    const transport = new FakeTransport();
    const videoRevisions: ContentRevisionSource = {
      async getRevision(revisionId) {
        if (revisionId !== 'revision-1') return null;
        return {
          id: 'revision-1',
          contentItemId: 'content-1',
          revisionNumber: 1,
          kind: ContentKind.VIDEO,
          title: 'Video',
          bodyMarkdown: '',
          media: [],
          sourceHash: null,
          contentHash: CONTENT_HASH,
          createdAt: NOW,
        };
      },
    };
    const adapter = new WeChatAdapter({
      transport,
      revisions: videoRevisions,
      accounts: createAccountSource(true),
      now: () => NOW,
    });
    const target = {
      ...directTarget,
      deliveryMode: DeliveryMode.MANUAL_HANDOFF,
    };

    expect(await adapter.validate('revision-1', target)).toContainEqual(
      expect.objectContaining({ code: 'content-kind-unsupported' }),
    );
    await expect(adapter.prepare('revision-1', target)).rejects.toMatchObject({
      name: 'PlatformValidationError',
    });
    expect(transport.requests).toEqual([]);
  });
});
