import { createHash } from 'node:crypto';

import { z } from 'zod';

export const ContentKind = {
  ARTICLE: 'ARTICLE',
  IMAGE_POST: 'IMAGE_POST',
  VIDEO: 'VIDEO',
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

export const ContentKindSchema = z.enum([
  ContentKind.ARTICLE,
  ContentKind.IMAGE_POST,
  ContentKind.VIDEO,
]);

export const DeliveryMode = {
  DIRECT_API: 'DIRECT_API',
  REMOTE_DRAFT: 'REMOTE_DRAFT',
  ASSISTED_BROWSER: 'ASSISTED_BROWSER',
  MANUAL_HANDOFF: 'MANUAL_HANDOFF',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export type DeliveryMode = (typeof DeliveryMode)[keyof typeof DeliveryMode];

export const DeliveryModeSchema = z.enum([
  DeliveryMode.DIRECT_API,
  DeliveryMode.REMOTE_DRAFT,
  DeliveryMode.ASSISTED_BROWSER,
  DeliveryMode.MANUAL_HANDOFF,
  DeliveryMode.UNSUPPORTED,
]);

export const JobState = {
  DRAFT: 'DRAFT',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  SCHEDULED: 'SCHEDULED',
  PREPARING: 'PREPARING',
  SUBMITTED: 'SUBMITTED',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  NEEDS_ACTION: 'NEEDS_ACTION',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  CANCELLED: 'CANCELLED',
} as const;

export type JobState = (typeof JobState)[keyof typeof JobState];

export const JobStateSchema = z.enum([
  JobState.DRAFT,
  JobState.AWAITING_APPROVAL,
  JobState.APPROVED,
  JobState.SCHEDULED,
  JobState.PREPARING,
  JobState.SUBMITTED,
  JobState.PROCESSING,
  JobState.PUBLISHED,
  JobState.REJECTED,
  JobState.NEEDS_ACTION,
  JobState.FAILED,
  JobState.UNKNOWN,
  JobState.CANCELLED,
]);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

export const EntityIdSchema = z.string().trim().min(1);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const PublishIdempotencyKeySchema = z.string().regex(/^publish_[a-f0-9]{64}$/);

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
};

const canonicalizeJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key] as JsonValue)}`);
  return `{${entries.join(',')}}`;
};

export const hashCanonicalJson = (value: JsonValue): string =>
  createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
