import { z } from 'zod';

import {
  ContentKind,
  ContentKindSchema,
  DeliveryModeSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  JobStateSchema,
  JsonObjectSchema,
  PublishIdempotencyKeySchema,
  Sha256Schema,
  type DeepReadonly,
} from './primitives.js';

export const SourceAttributionSchema = z
  .object({
    importer: EntityIdSchema,
    sourceId: EntityIdSchema,
    sourceHash: Sha256Schema,
  })
  .strict();

export type SourceAttribution = z.infer<typeof SourceAttributionSchema>;

export const ContentItemSchema = z
  .object({
    id: EntityIdSchema,
    kind: ContentKindSchema,
    title: z.string(),
    currentRevisionId: EntityIdSchema.nullable(),
    source: SourceAttributionSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type ContentItem = z.infer<typeof ContentItemSchema>;

export const RevisionMediaSchema = z
  .object({
    assetId: EntityIdSchema,
    sha256: Sha256Schema,
    order: z.number().int().nonnegative(),
  })
  .strict();

export type RevisionMedia = z.infer<typeof RevisionMediaSchema>;

export const ContentRevisionInputSchema = z
  .object({
    id: EntityIdSchema,
    contentItemId: EntityIdSchema,
    revisionNumber: z.number().int().positive(),
    kind: ContentKindSchema,
    title: z.string(),
    bodyMarkdown: z.string(),
    media: z.array(RevisionMediaSchema),
    sourceHash: Sha256Schema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const ContentRevisionSchema = ContentRevisionInputSchema.extend({
  contentHash: Sha256Schema,
}).strict();

export type ContentRevision = DeepReadonly<z.infer<typeof ContentRevisionSchema>>;
export type CreateContentRevisionInput = z.input<typeof ContentRevisionInputSchema>;

export const MediaAssetSchema = z
  .object({
    id: EntityIdSchema,
    kind: z.enum([ContentKind.IMAGE_POST, ContentKind.VIDEO]),
    sha256: Sha256Schema,
    storagePath: z.string().min(1),
    originalName: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const PlatformVariantInputSchema = z
  .object({
    id: EntityIdSchema,
    revisionId: EntityIdSchema,
    platform: EntityIdSchema,
    title: z.string().nullable(),
    bodyMarkdown: z.string().nullable(),
    media: z.array(RevisionMediaSchema).nullable(),
    platformFields: JsonObjectSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const PlatformVariantSchema = PlatformVariantInputSchema.extend({
  contentHash: Sha256Schema,
}).strict();

export type PlatformVariant = DeepReadonly<z.infer<typeof PlatformVariantSchema>>;
export type CreatePlatformVariantInput = z.input<typeof PlatformVariantInputSchema>;

export const AccountConnectionSchema = z
  .object({
    id: EntityIdSchema,
    platform: EntityIdSchema,
    externalAccountId: z.string().min(1).nullable(),
    displayName: z.string().min(1),
    deliveryMode: DeliveryModeSchema,
    credentialRef: z.string().min(1).nullable(),
    enabled: z.boolean(),
    capabilitiesCheckedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type AccountConnection = z.infer<typeof AccountConnectionSchema>;

export const PublishTargetSchema = z
  .object({
    accountId: EntityIdSchema,
    platform: EntityIdSchema,
    deliveryMode: DeliveryModeSchema,
    scheduledAt: IsoDateTimeSchema.nullable(),
    platformFields: JsonObjectSchema,
  })
  .strict();

export type PublishTarget = z.infer<typeof PublishTargetSchema>;

export const ApprovalBindingSchema = z
  .object({
    contentHash: Sha256Schema,
    approvedBy: EntityIdSchema,
    approvedAt: IsoDateTimeSchema,
  })
  .strict();

export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

export const PublishPlanSchema = z
  .object({
    id: EntityIdSchema,
    revisionId: EntityIdSchema,
    variantIds: z.array(EntityIdSchema),
    targets: z.array(PublishTargetSchema),
    contentHash: Sha256Schema,
    approval: ApprovalBindingSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type PublishPlan = DeepReadonly<z.infer<typeof PublishPlanSchema>>;

export const PublishJobSchema = z
  .object({
    id: EntityIdSchema,
    planId: EntityIdSchema,
    revisionId: EntityIdSchema,
    variantId: EntityIdSchema.nullable(),
    accountId: EntityIdSchema,
    platform: EntityIdSchema,
    deliveryMode: DeliveryModeSchema,
    state: JobStateSchema,
    idempotencyKey: PublishIdempotencyKeySchema,
    scheduledAt: IsoDateTimeSchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    remotePublicationId: z.string().min(1).nullable(),
    statusMessage: z.string().min(1).nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export type PublishJob = DeepReadonly<z.infer<typeof PublishJobSchema>>;

export const PublishAttemptSchema = z
  .object({
    id: EntityIdSchema,
    jobId: EntityIdSchema,
    attemptNumber: z.number().int().positive(),
    state: JobStateSchema,
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
    receiptId: z.string().min(1).nullable(),
    errorCode: z.string().min(1).nullable(),
    errorMessage: z.string().min(1).nullable(),
  })
  .strict();

export type PublishAttempt = z.infer<typeof PublishAttemptSchema>;

export const RunArtifactSchema = z
  .object({
    id: EntityIdSchema,
    jobId: EntityIdSchema,
    attemptId: EntityIdSchema.nullable(),
    kind: z.enum(['LOG', 'SCREENSHOT', 'RECEIPT', 'EXPORT']),
    storagePath: z.string().min(1),
    mimeType: z.string().min(1).nullable(),
    sha256: Sha256Schema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type RunArtifact = z.infer<typeof RunArtifactSchema>;
