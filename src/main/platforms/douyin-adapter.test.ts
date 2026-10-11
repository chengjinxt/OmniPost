import { describe, expect, it } from 'vitest';

import { ContentKind, DeliveryMode } from '../../domain/index.js';
import {
  type AccountConnectionSource,
  type ContentRevisionSource,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './adapter-runtime.js';
import { DouyinAdapter } from './douyin-adapter.js';

const NOW = '2026-10-12T03:10:00.000Z';
const CONTENT_HASH = 'b'.repeat(64);

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

function revisionSource(kind: 'IMAGE_POST' | 'VIDEO'): ContentRevisionSource {
  return {
    async getRevision(revisionId) {
      if (revisionId !== 'revision-1') return null;
      return {
        id: 'revision-1',
        contentItemId: 'content-1',
        revisionNumber: 1,
        kind,
        title: 'A release update',
        bodyMarkdown: 'Release details',
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
      if (accountId !== 'douyin-account') return null;
      return {
        accountId,
        credentials: {
          accessToken: 'douyin-test-token',
          openId: 'douyin-open-id',
        },
        capabilityContext: {
          qualifications: hasPermission ? ['DOUYIN_APPROVED_APPLICATION'] : [],
          scopes: hasPermission ? ['video.create.bind', 'posting.behavior'] : [],
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

describe('DouyinAdapter', () => {
  it('submits a video with the user OAuth token and maps review completion', async () => {
    const transport = new FakeTransport(
      { status: 200, body: { data: { item_id: 'douyin-item-1', error_code: 0 } } },
      {
        status: 200,
        body: {
          data: {
            list: [
              {
                item_id: 'douyin-item-1',
                video_id: '7227815678634470001',
                video_status: 5,
              },
            ],
          },
        },
      },
    );
    const adapter = new DouyinAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'douyin-account',
      platform: 'douyin',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: null,
      platformFields: {
        remoteMediaIds: ['video-id-1'],
        text: 'A release update #OmniPost',
      },
    };

    expect(await adapter.validate('revision-1', target)).toEqual([]);
    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);

    expect(transport.requests[0]).toEqual({
      method: 'POST',
      url: 'https://open.douyin.com/api/douyin/v1/video/create_video/?open_id=douyin-open-id',
      headers: {
        'access-token': 'douyin-test-token',
        'content-type': 'application/json',
      },
      body: {
        video_id: 'video-id-1',
        text: 'A release update #OmniPost',
      },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(receipt.remoteId).toBe('douyin-item-1');

    expect(receipt).toMatchObject({
      accountId: 'douyin-account',
      deliveryMode: DeliveryMode.DIRECT_API,
      idempotencyKey: prepared.idempotencyKey,
    });
    const restartedAdapter = new DouyinAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const status = await restartedAdapter.poll(receipt);
    expect(transport.requests[1]).toEqual({
      method: 'POST',
      url: 'https://open.douyin.com/api/douyin/v1/video/video_basic_info/?open_id=douyin-open-id',
      headers: {
        'access-token': 'douyin-test-token',
        'content-type': 'application/json',
      },
      body: { item_ids: ['douyin-item-1'] },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(status).toMatchObject({
      state: 'PUBLISHED',
      remoteId: 'douyin-item-1',
      url: 'https://www.douyin.com/video/7227815678634470001',
    });
  });

  it('uses the image-text endpoint and preserves every remote image id', async () => {
    const transport = new FakeTransport({
      status: 200,
      body: { data: { item_id: 'douyin-image-item-1', error_code: 0 } },
    });
    const adapter = new DouyinAdapter({
      transport,
      revisions: revisionSource(ContentKind.IMAGE_POST),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'douyin-account',
      platform: 'douyin',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: null,
      platformFields: {
        remoteMediaIds: ['image-id-1', 'image-id-2'],
        title: 'Douyin variant title',
      },
    };

    const prepared = await adapter.prepare('revision-1', target);
    await adapter.submit(prepared.id);

    expect(transport.requests[0]).toMatchObject({
      url: 'https://open.douyin.com/api/douyin/v1/video/create_image_text/?open_id=douyin-open-id',
      body: {
        image_list: ['image-id-1', 'image-id-2'],
        text: 'Douyin variant title',
      },
      idempotencyKey: prepared.idempotencyKey,
    });
  });

  it('offers a visible assisted handoff when video.create is unavailable', async () => {
    const transport = new FakeTransport();
    const adapter = new DouyinAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(false),
      now: () => NOW,
    });
    const target = {
      accountId: 'douyin-account',
      platform: 'douyin',
      deliveryMode: DeliveryMode.ASSISTED_BROWSER,
      scheduledAt: null,
      platformFields: { remoteMediaIds: ['video-id-1'] },
    };

    const capabilities = await adapter.probeCapabilities('douyin-account');
    expect(capabilities.deliveryModes).toEqual([
      DeliveryMode.MANUAL_HANDOFF,
      DeliveryMode.ASSISTED_BROWSER,
    ]);
    expect(capabilities.scopes).toContainEqual({
      name: 'video.create.bind',
      granted: false,
    });

    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);
    expect(transport.requests).toEqual([]);
    expect(receipt.remoteId).toBeNull();
    expect(await adapter.poll(receipt)).toMatchObject({ state: 'NEEDS_ACTION' });
    expect(await adapter.openAssistedFlow(prepared.id)).toMatchObject({ status: 'OPEN' });
  });
});
