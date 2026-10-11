import { describe, expect, it } from 'vitest';

import { ContentKind, createContentRevision } from '../../domain/index.js';
import {
  AiVariantGenerationError,
  OpenAiCompatibleVariantGenerator,
  type AiHttpRequest,
  type AiHttpResponse,
  type AiHttpTransport,
} from './ai-variant-generator.js';

const CREATED_AT = '2026-10-12T04:00:00.000Z';

class QueueTransport implements AiHttpTransport {
  readonly requests: AiHttpRequest[] = [];

  constructor(private readonly results: Array<AiHttpResponse | Error>) {}

  async send(request: AiHttpRequest): Promise<AiHttpResponse> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('No queued HTTP result');
    if (result instanceof Error) throw result;
    return result;
  }
}

const createRevision = () =>
  createContentRevision({
    id: 'revision-1',
    contentItemId: 'content-1',
    revisionNumber: 1,
    kind: ContentKind.ARTICLE,
    title: 'Canonical title',
    bodyMarkdown: '# Canonical body',
    media: [{ assetId: 'asset-1', sha256: 'a'.repeat(64), order: 0 }],
    sourceHash: null,
    createdAt: '2026-10-12T03:00:00.000Z',
  });

const successfulResponsesBody = (output: unknown, model = 'configured-model') => ({
  id: 'resp-1',
  status: 'completed',
  model,
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(output) }],
    },
  ],
});

const validOutput = {
  title: 'WeChat title',
  bodyMarkdown: 'Adapted body',
  platformFields: [
    { key: 'digest', value: 'Short summary' },
    { key: 'tags', value: ['cross-posting', 'automation'] },
    { key: 'original', value: true },
  ],
};

const createGenerator = (transport: AiHttpTransport) =>
  new OpenAiCompatibleVariantGenerator({
    transport,
    config: {
      baseUrl: 'https://compatible.example.test/v1',
      baseUrlId: 'compatible-primary',
      model: 'configured-model',
      apiKey: 'test-secret-key',
    },
    createId: () => 'variant-ai-1',
    now: () => CREATED_AT,
  });

describe('OpenAiCompatibleVariantGenerator', () => {
  it('uses Responses Structured Outputs and creates a new immutable platform variant', async () => {
    const transport = new QueueTransport([
      { status: 200, body: successfulResponsesBody(validOutput) },
    ]);
    const generator = createGenerator(transport);
    const revision = createRevision();
    const originalSnapshot = JSON.stringify(revision);

    const result = await generator.generate({
      revision,
      platform: 'wechat',
      constraints: { maxTitleCharacters: 64, tone: 'clear' },
      promptVersion: 'wechat-v1',
    });

    expect(result.variant).toMatchObject({
      id: 'variant-ai-1',
      revisionId: revision.id,
      platform: 'wechat',
      title: 'WeChat title',
      bodyMarkdown: 'Adapted body',
      media: null,
      platformFields: {
        digest: 'Short summary',
        tags: ['cross-posting', 'automation'],
        original: true,
      },
      createdAt: CREATED_AT,
    });
    expect(result.variant).not.toBe(revision);
    expect(Object.isFrozen(result.variant)).toBe(true);
    expect(JSON.stringify(revision)).toBe(originalSnapshot);

    const request = transport.requests[0];
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://compatible.example.test/v1/responses',
      headers: {
        Authorization: 'Bearer test-secret-key',
        'Content-Type': 'application/json',
      },
    });
    expect(request?.body).toMatchObject({
      model: 'configured-model',
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'omnipost_platform_variant',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'bodyMarkdown', 'platformFields'],
            properties: {
              platformFields: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'value'],
                },
              },
            },
          },
        },
      },
    });
    expect(request?.body).not.toHaveProperty('response_format');
  });

  it('records reproducible provenance without recording the API key', async () => {
    const firstTransport = new QueueTransport([
      { status: 200, body: successfulResponsesBody(validOutput) },
    ]);
    const secondTransport = new QueueTransport([
      { status: 200, body: successfulResponsesBody(validOutput) },
    ]);
    const input = {
      revision: createRevision(),
      platform: 'wechat',
      constraints: { tone: 'clear', limits: { title: 64, body: 10_000 } },
      promptVersion: 'wechat-v1',
    } as const;

    const first = await createGenerator(firstTransport).generate(input);
    const second = await createGenerator(secondTransport).generate(input);

    expect(first.generation).toEqual({
      variantId: 'variant-ai-1',
      model: 'configured-model',
      baseUrlId: 'compatible-primary',
      promptVersion: 'wechat-v1',
      requestHash: first.generation.requestHash,
      responseHash: first.generation.responseHash,
      createdAt: CREATED_AT,
    });
    expect(first.generation.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.generation.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.generation.requestHash).toBe(first.generation.requestHash);
    expect(second.generation.responseHash).toBe(first.generation.responseHash);
    expect(JSON.stringify(first)).not.toContain('test-secret-key');
  });

  it('supports a configured Chat Completions compatible endpoint', async () => {
    const transport = new QueueTransport([
      {
        status: 200,
        body: {
          id: 'chatcmpl-1',
          model: 'compat-chat-model',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(validOutput), refusal: null },
            },
          ],
        },
      },
    ]);
    const generator = new OpenAiCompatibleVariantGenerator({
      transport,
      config: {
        baseUrl: 'https://chat.example.test/api/v1/',
        baseUrlId: 'chat-compatible',
        model: 'compat-chat-model',
        endpoint: 'CHAT_COMPLETIONS',
      },
      createId: () => 'variant-chat-1',
      now: () => CREATED_AT,
    });

    const result = await generator.generate({
      revision: createRevision(),
      platform: 'medium',
      constraints: {},
      promptVersion: 'medium-v2',
    });

    expect(result.variant.id).toBe('variant-chat-1');
    expect(result.generation.model).toBe('compat-chat-model');
    expect(transport.requests[0]).toMatchObject({
      url: 'https://chat.example.test/api/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'compat-chat-model',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'omnipost_platform_variant',
            strict: true,
          },
        },
      },
    });
    expect(transport.requests[0]?.headers).not.toHaveProperty('Authorization');
    expect(transport.requests[0]?.body).not.toHaveProperty('text');
  });

  it('surfaces an explicit refusal without creating a variant', async () => {
    const transport = new QueueTransport([
      {
        status: 200,
        body: {
          id: 'resp-refusal',
          status: 'completed',
          model: 'configured-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'Unable to transform this content.' }],
            },
          ],
        },
      },
    ]);

    await expect(
      createGenerator(transport).generate({
        revision: createRevision(),
        platform: 'wechat',
        constraints: {},
        promptVersion: 'wechat-v1',
      }),
    ).rejects.toMatchObject({
      name: 'AiVariantGenerationError',
      code: 'REFUSAL',
      retryable: false,
      diagnostics: {
        model: 'configured-model',
        baseUrlId: 'compatible-primary',
        promptVersion: 'wechat-v1',
        responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('surfaces an incomplete response separately from schema errors', async () => {
    const transport = new QueueTransport([
      {
        status: 200,
        body: {
          id: 'resp-incomplete',
          status: 'incomplete',
          model: 'configured-model',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        },
      },
    ]);

    await expect(
      createGenerator(transport).generate({
        revision: createRevision(),
        platform: 'wechat',
        constraints: {},
        promptVersion: 'wechat-v1',
      }),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE',
      retryable: true,
    });
  });

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'schema mismatch',
      JSON.stringify({ title: 42, bodyMarkdown: 'Body', platformFields: [] }),
    ],
    [
      'duplicate platform fields',
      JSON.stringify({
        title: 'Title',
        bodyMarkdown: 'Body',
        platformFields: [
          { key: 'tag', value: 'first' },
          { key: 'tag', value: 'second' },
        ],
      }),
    ],
  ])('rejects %s output before creating a domain variant', async (_name, text) => {
    const body = successfulResponsesBody(validOutput);
    body.output[0]!.content[0]!.text = text;
    const transport = new QueueTransport([{ status: 200, body }]);

    await expect(
      createGenerator(transport).generate({
        revision: createRevision(),
        platform: 'wechat',
        constraints: {},
        promptVersion: 'wechat-v1',
      }),
    ).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
      retryable: false,
    });
  });

  it('wraps transport failures as retryable network errors with safe diagnostics', async () => {
    const transport = new QueueTransport([new Error('socket closed')]);

    let caught: unknown;
    try {
      await createGenerator(transport).generate({
        revision: createRevision(),
        platform: 'wechat',
        constraints: {},
        promptVersion: 'wechat-v1',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AiVariantGenerationError);
    expect(caught).toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      diagnostics: {
        model: 'configured-model',
        baseUrlId: 'compatible-primary',
        promptVersion: 'wechat-v1',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseHash: null,
      },
    });
    expect(JSON.stringify(caught)).not.toContain('test-secret-key');
  });
});
