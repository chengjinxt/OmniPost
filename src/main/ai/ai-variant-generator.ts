import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  ContentRevisionSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  JsonValueSchema,
  Sha256Schema,
  createPlatformVariant,
  deepFreeze,
  hashCanonicalJson,
  type ContentRevision,
  type DeepReadonly,
  type JsonObject,
  type JsonValue,
  type PlatformVariant,
} from '../../domain/index.js';

export interface AiHttpRequest {
  method: 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body: JsonObject;
}

export interface AiHttpResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface AiHttpTransport {
  send(request: AiHttpRequest): Promise<AiHttpResponse>;
}

export const AiProviderConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    baseUrlId: EntityIdSchema,
    model: z.string().trim().min(1),
    apiKey: z.string().min(1).optional(),
    endpoint: z.enum(['RESPONSES', 'CHAT_COMPLETIONS']).default('RESPONSES'),
    endpointPath: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/).optional(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type AiProviderConfig = z.input<typeof AiProviderConfigSchema>;

const PlatformFieldValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export const AiVariantPayloadSchema = z
  .object({
    title: z.string().nullable(),
    bodyMarkdown: z.string().nullable(),
    platformFields: z.array(
      z
        .object({
          key: z.string().min(1),
          value: PlatformFieldValueSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    value.platformFields.forEach((field, index) => {
      if (keys.has(field.key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate platform field: ${field.key}`,
          path: ['platformFields', index, 'key'],
        });
      }
      keys.add(field.key);
    });
  });

export type AiVariantPayload = z.infer<typeof AiVariantPayloadSchema>;

const GeneratePlatformVariantInputSchema = z
  .object({
    revision: ContentRevisionSchema,
    platform: EntityIdSchema,
    constraints: JsonObjectSchema,
    promptVersion: EntityIdSchema,
  })
  .strict();

export interface GeneratePlatformVariantInput {
  revision: ContentRevision;
  platform: string;
  constraints: DeepReadonly<JsonObject>;
  promptVersion: string;
}

export const AiGenerationRecordSchema = z
  .object({
    variantId: EntityIdSchema,
    model: z.string().min(1),
    baseUrlId: EntityIdSchema,
    promptVersion: EntityIdSchema,
    requestHash: Sha256Schema,
    responseHash: Sha256Schema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type AiGenerationRecord = DeepReadonly<z.infer<typeof AiGenerationRecordSchema>>;

export interface AiVariantGeneration {
  readonly variant: PlatformVariant;
  readonly generation: AiGenerationRecord;
}

export const AiVariantErrorCode = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  API_ERROR: 'API_ERROR',
  REFUSAL: 'REFUSAL',
  INCOMPLETE: 'INCOMPLETE',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
} as const;

export type AiVariantErrorCode =
  (typeof AiVariantErrorCode)[keyof typeof AiVariantErrorCode];

export interface AiGenerationDiagnostics {
  readonly model: string;
  readonly baseUrlId: string;
  readonly promptVersion: string;
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly createdAt: string;
}

export class AiVariantGenerationError extends Error {
  readonly name = 'AiVariantGenerationError';

  constructor(
    readonly code: AiVariantErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly diagnostics: AiGenerationDiagnostics,
  ) {
    super(message);
  }
}

interface GeneratorDependencies {
  transport: AiHttpTransport;
  config: AiProviderConfig;
  createId?: () => string;
  now?: () => string;
}

const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'bodyMarkdown', 'platformFields'],
  properties: {
    title: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    bodyMarkdown: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    platformFields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value'],
        properties: {
          key: { type: 'string' },
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
    },
  },
} as const;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'omnipost_platform_variant',
  strict: true,
  schema: STRUCTURED_OUTPUT_SCHEMA,
} as const;

const SYSTEM_PROMPT = [
  'Create a platform-specific variant of the supplied immutable source content.',
  'Preserve factual meaning. Return null for title or bodyMarkdown when the source value should be inherited unchanged.',
  'Return platform-specific fields as unique key/value entries. Do not include commentary outside the schema.',
].join(' ');

const stableJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(',')}}`;
};

const buildUserPrompt = (input: z.infer<typeof GeneratePlatformVariantInputSchema>): string =>
  stableJson({
    promptVersion: input.promptVersion,
    platform: input.platform,
    constraints: input.constraints,
    source: {
      kind: input.revision.kind,
      title: input.revision.title,
      bodyMarkdown: input.revision.bodyMarkdown,
      media: input.revision.media.map((media) => ({
        assetId: media.assetId,
        sha256: media.sha256,
        order: media.order,
      })),
    },
  });

const buildRequestBody = (
  config: z.output<typeof AiProviderConfigSchema>,
  input: z.infer<typeof GeneratePlatformVariantInputSchema>,
): JsonObject => {
  const userPrompt = buildUserPrompt(input);
  if (config.endpoint === 'CHAT_COMPLETIONS') {
    return JsonObjectSchema.parse({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: RESPONSE_FORMAT,
      },
    });
  }

  return JsonObjectSchema.parse({
    model: config.model,
    instructions: SYSTEM_PROMPT,
    input: userPrompt,
    store: false,
    text: { format: RESPONSE_FORMAT },
  });
};

const responseHash = (body: unknown): string | null => {
  const parsed = JsonValueSchema.safeParse(body);
  return parsed.success ? hashCanonicalJson(parsed.data) : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ExtractedOutput {
  text: string;
  model: string | null;
}

type ErrorFactory = (
  code: AiVariantErrorCode,
  message: string,
  retryable: boolean,
) => AiVariantGenerationError;

const extractResponsesOutput = (
  body: unknown,
  error: ErrorFactory,
): ExtractedOutput => {
  if (!isRecord(body)) {
    throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Responses body must be an object', false);
  }

  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
  if (body.status === 'incomplete' || body.status === 'queued' || body.status === 'in_progress') {
    throw error(AiVariantErrorCode.INCOMPLETE, 'AI response is incomplete', true);
  }
  if (body.status === 'failed' || body.status === 'cancelled') {
    throw error(AiVariantErrorCode.API_ERROR, `AI response ended with status ${body.status}`, false);
  }
  if (body.status !== 'completed' || !Array.isArray(body.output)) {
    throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Responses output is missing', false);
  }

  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === 'refusal' && typeof content.refusal === 'string') {
        throw error(AiVariantErrorCode.REFUSAL, 'AI provider refused the request', false);
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return { text: content.text, model };
      }
    }
  }

  throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Responses output text is missing', false);
};

const extractChatCompletionsOutput = (
  body: unknown,
  error: ErrorFactory,
): ExtractedOutput => {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
    throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Chat completion choice is missing', false);
  }

  const choice = body.choices[0];
  const message = choice.message;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
  if (!isRecord(message)) {
    throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Chat completion message is missing', false);
  }
  if (typeof message.refusal === 'string' && message.refusal.length > 0) {
    throw error(AiVariantErrorCode.REFUSAL, 'AI provider refused the request', false);
  }
  if (choice.finish_reason !== 'stop') {
    throw error(AiVariantErrorCode.INCOMPLETE, 'Chat completion did not finish normally', true);
  }
  if (typeof message.content !== 'string') {
    throw error(AiVariantErrorCode.MALFORMED_RESPONSE, 'Chat completion content is missing', false);
  }

  return { text: message.content, model };
};

const parsePayload = (text: string, error: ErrorFactory): AiVariantPayload => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw error(AiVariantErrorCode.SCHEMA_INVALID, 'AI output is not valid JSON', false);
  }

  const parsed = AiVariantPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw error(AiVariantErrorCode.SCHEMA_INVALID, 'AI output does not match the variant schema', false);
  }
  return parsed.data;
};

export class OpenAiCompatibleVariantGenerator {
  readonly #transport: AiHttpTransport;
  readonly #config: z.output<typeof AiProviderConfigSchema>;
  readonly #createId: () => string;
  readonly #now: () => string;

  constructor(dependencies: GeneratorDependencies) {
    this.#transport = dependencies.transport;
    this.#config = AiProviderConfigSchema.parse(dependencies.config);
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async generate(inputValue: GeneratePlatformVariantInput): Promise<AiVariantGeneration> {
    const input = GeneratePlatformVariantInputSchema.parse(inputValue);
    const createdAt = IsoDateTimeSchema.parse(this.#now());
    const requestBody = buildRequestBody(this.#config, input);
    const requestHash = hashCanonicalJson(requestBody);
    let currentResponseHash: string | null = null;

    const diagnostics = (): AiGenerationDiagnostics => ({
      model: this.#config.model,
      baseUrlId: this.#config.baseUrlId,
      promptVersion: input.promptVersion,
      requestHash,
      responseHash: currentResponseHash,
      createdAt,
    });
    const generationError: ErrorFactory = (code, message, retryable) =>
      new AiVariantGenerationError(code, message, retryable, diagnostics());

    const request: AiHttpRequest = {
      method: 'POST',
      url: this.#endpointUrl(),
      headers: {
        'Content-Type': 'application/json',
        ...this.#config.headers,
        ...(this.#config.apiKey ? { Authorization: `Bearer ${this.#config.apiKey}` } : {}),
      },
      body: requestBody,
    };

    let response: AiHttpResponse;
    try {
      response = await this.#transport.send(request);
    } catch {
      throw generationError(
        AiVariantErrorCode.NETWORK_ERROR,
        'AI transport request failed',
        true,
      );
    }

    currentResponseHash = responseHash(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw generationError(
        AiVariantErrorCode.HTTP_ERROR,
        `AI endpoint returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const extracted =
      this.#config.endpoint === 'CHAT_COMPLETIONS'
        ? extractChatCompletionsOutput(response.body, generationError)
        : extractResponsesOutput(response.body, generationError);
    const payload = parsePayload(extracted.text, generationError);
    const variantId = EntityIdSchema.parse(this.#createId());
    const platformFields = JsonObjectSchema.parse(
      Object.fromEntries(payload.platformFields.map((field) => [field.key, field.value])),
    );
    const variant = createPlatformVariant({
      id: variantId,
      revisionId: input.revision.id,
      platform: input.platform,
      title: payload.title,
      bodyMarkdown: payload.bodyMarkdown,
      media: null,
      platformFields,
      createdAt,
    });
    const generation = deepFreeze(
      AiGenerationRecordSchema.parse({
        variantId,
        model: extracted.model ?? this.#config.model,
        baseUrlId: this.#config.baseUrlId,
        promptVersion: input.promptVersion,
        requestHash,
        responseHash: currentResponseHash,
        createdAt,
      }),
    );

    return deepFreeze({ variant, generation });
  }

  #endpointUrl(): string {
    const baseUrl = this.#config.baseUrl.replace(/\/+$/, '');
    const defaultPath =
      this.#config.endpoint === 'CHAT_COMPLETIONS' ? '/chat/completions' : '/responses';
    return `${baseUrl}${this.#config.endpointPath ?? defaultPath}`;
  }
}
