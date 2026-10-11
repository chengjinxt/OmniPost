import { describe, expect, it } from 'vitest';

import { ContentKind, DeliveryMode } from '../../domain/index.js';
import {
  type AccountConnectionSource,
  type ContentRevisionSource,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './adapter-runtime.js';
import { YouTubeAdapter } from './youtube-adapter.js';

const NOW = '2026-10-12T04:00:00.000Z';
const CONTENT_HASH = 'c'.repeat(64);

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

function revisionSource(kind: 'ARTICLE' | 'VIDEO'): ContentRevisionSource {
  return {
    async getRevision(revisionId) {
      if (revisionId !== 'revision-1') return null;
      return {
        id: 'revision-1',
        contentItemId: 'content-1',
        revisionNumber: 1,
        kind,
        title: 'OmniPost release walkthrough',
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
      if (accountId !== 'youtube-account') return null;
      return {
        accountId,
        credentials: { accessToken: 'youtube-test-token' },
        capabilityContext: {
          qualifications: [],
          scopes: hasPermission ? ['youtube.upload'] : [],
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

describe('YouTubeAdapter', () => {
  it('uploads a scheduled video and maps completed processing', async () => {
    const transport = new FakeTransport(
      {
        status: 200,
        body: { id: 'youtube-video-1', status: { uploadStatus: 'uploaded' } },
      },
      {
        status: 200,
        body: {
          items: [
            {
              id: 'youtube-video-1',
              processingDetails: { processingStatus: 'succeeded' },
              status: { privacyStatus: 'private' },
            },
          ],
        },
      },
    );
    const adapter = new YouTubeAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'youtube-account',
      platform: 'youtube',
      deliveryMode: DeliveryMode.DIRECT_API,
      scheduledAt: '2026-10-13T08:00:00.000Z',
      platformFields: {
        title: 'YouTube variant title',
        uploadUri: 'file:///workspace/release.mp4',
        bodyMarkdown: 'YouTube variant description',
        tags: ['release', 'omnipost'],
        categoryId: '28',
        privacyStatus: 'public',
      },
    };

    expect(await adapter.validate('revision-1', target)).toEqual([]);
    const prepared = await adapter.prepare('revision-1', target);
    const receipt = await adapter.submit(prepared.id);

    expect(transport.requests[0]).toEqual({
      method: 'POST',
      url: 'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet%2Cstatus&uploadType=multipart',
      headers: {
        authorization: 'Bearer youtube-test-token',
        'content-type': 'application/json',
      },
      body: {
        metadata: {
          snippet: {
            title: 'YouTube variant title',
            description: 'YouTube variant description',
            tags: ['release', 'omnipost'],
            categoryId: '28',
          },
          status: {
            privacyStatus: 'private',
            publishAt: '2026-10-13T08:00:00.000Z',
          },
        },
        media: { uri: 'file:///workspace/release.mp4' },
      },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(receipt.remoteId).toBe('youtube-video-1');
    expect(receipt).toMatchObject({
      accountId: 'youtube-account',
      deliveryMode: DeliveryMode.DIRECT_API,
      idempotencyKey: prepared.idempotencyKey,
    });

    const restartedAdapter = new YouTubeAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const status = await restartedAdapter.poll(receipt);
    expect(transport.requests[1]).toEqual({
      method: 'GET',
      url: 'https://www.googleapis.com/youtube/v3/videos?part=processingDetails%2Cstatus&id=youtube-video-1',
      headers: { authorization: 'Bearer youtube-test-token' },
      idempotencyKey: prepared.idempotencyKey,
    });
    expect(status).toMatchObject({
      state: 'PUBLISHED',
      remoteId: 'youtube-video-1',
      url: 'https://www.youtube.com/watch?v=youtube-video-1',
    });
  });

  it('rejects non-video content before any HTTP request', async () => {
    const transport = new FakeTransport();
    const adapter = new YouTubeAdapter({
      transport,
      revisions: revisionSource(ContentKind.ARTICLE),
      accounts: accountSource(true),
      now: () => NOW,
    });
    const target = {
      accountId: 'youtube-account',
      platform: 'youtube',
      deliveryMode: DeliveryMode.UNSUPPORTED,
      scheduledAt: null,
      platformFields: {},
    };

    expect(await adapter.validate('revision-1', target)).toContainEqual(
      expect.objectContaining({ code: 'content-kind-unsupported' }),
    );
    await expect(adapter.prepare('revision-1', target)).rejects.toMatchObject({
      name: 'PlatformValidationError',
    });
    expect(transport.requests).toEqual([]);
  });

  it('degrades to manual handoff when youtube.upload is unavailable', async () => {
    const transport = new FakeTransport();
    const adapter = new YouTubeAdapter({
      transport,
      revisions: revisionSource(ContentKind.VIDEO),
      accounts: accountSource(false),
      now: () => NOW,
    });
    const target = {
      accountId: 'youtube-account',
      platform: 'youtube',
      deliveryMode: DeliveryMode.MANUAL_HANDOFF,
      scheduledAt: null,
      platformFields: { uploadUri: 'file:///workspace/release.mp4' },
    };

    expect((await adapter.probeCapabilities('youtube-account')).deliveryModes).toEqual([
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
