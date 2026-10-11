import { z } from 'zod';

import { PublishTargetSchema, type ContentRevision, type PublishTarget } from './entities.js';
import {
  ContentKindSchema,
  DeliveryModeSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  JobState,
  PublishIdempotencyKeySchema,
  Sha256Schema,
} from './primitives.js';

export const ImportCandidateSchema = z
  .object({
    id: EntityIdSchema,
    importer: EntityIdSchema,
    sourceRoot: z.string().min(1),
    sourcePath: z.string().min(1),
    relativePath: z.string().min(1),
    titleHint: z.string(),
    kind: ContentKindSchema,
    sourceHash: Sha256Schema,
    metadata: JsonObjectSchema,
  })
  .strict();

export type ImportCandidate = z.infer<typeof ImportCandidateSchema>;

export const ImportPreviewMediaSchema = z
  .object({
    sourcePath: z.string().min(1),
    originalName: z.string().min(1),
    kind: z.enum(['IMAGE_POST', 'VIDEO']),
    order: z.number().int().nonnegative(),
    sha256: Sha256Schema.nullable(),
  })
  .strict();

export const ImportPreviewSchema = z
  .object({
    candidate: ImportCandidateSchema,
    title: z.string(),
    bodyMarkdown: z.string(),
    frontmatter: JsonObjectSchema,
    media: z.array(ImportPreviewMediaSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export interface SourceImporter {
  discover(root: string): Promise<ImportCandidate[]>;
  preview(candidate: ImportCandidate): Promise<ImportPreview>;
  ingest(candidate: ImportCandidate): Promise<ContentRevision>;
}

const CapabilityStatusSchema = z.enum(['SATISFIED', 'MISSING', 'UNKNOWN']);
const ProbeStatusSchema = z.enum(['PASS', 'FAIL', 'UNKNOWN']);

export const AccountCapabilitiesSchema = z
  .object({
    accountId: EntityIdSchema,
    platform: EntityIdSchema,
    deliveryModes: z.array(DeliveryModeSchema),
    contentKinds: z.array(ContentKindSchema),
    features: z
      .object({
        supportsDrafts: z.boolean(),
        supportsScheduling: z.boolean(),
        supportsRemoteStatus: z.boolean(),
      })
      .strict(),
    qualifications: z.array(
      z
        .object({
          code: EntityIdSchema,
          label: z.string().min(1),
          status: CapabilityStatusSchema,
          details: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    scopes: z.array(
      z
        .object({
          name: EntityIdSchema,
          granted: z.boolean(),
        })
        .strict(),
    ),
    probes: z.array(
      z
        .object({
          code: EntityIdSchema,
          status: ProbeStatusSchema,
          message: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    checkedAt: IsoDateTimeSchema,
  })
  .strict();

export type AccountCapabilities = z.infer<typeof AccountCapabilitiesSchema>;

export const ValidationIssueSchema = z
  .object({
    code: EntityIdSchema,
    message: z.string().min(1),
    severity: z.enum(['ERROR', 'WARNING']),
    field: z.string().min(1).nullable(),
  })
  .strict();

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const PreparedPublicationSchema = z
  .object({
    id: EntityIdSchema,
    revisionId: EntityIdSchema,
    target: PublishTargetSchema,
    contentHash: Sha256Schema,
    idempotencyKey: PublishIdempotencyKeySchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type PreparedPublication = z.infer<typeof PreparedPublicationSchema>;

const RemotePublicationStateSchema = z.enum([
  JobState.PROCESSING,
  JobState.PUBLISHED,
  JobState.REJECTED,
  JobState.NEEDS_ACTION,
  JobState.FAILED,
  JobState.UNKNOWN,
]);

export const SubmissionStatusMetadataSchema = z
  .object({
    state: RemotePublicationStateSchema,
    url: z.string().url().nullable(),
    message: z.string().min(1).nullable(),
  })
  .strict();

export type SubmissionStatusMetadata = z.infer<typeof SubmissionStatusMetadataSchema>;

export const SubmissionReceiptSchema = z
  .object({
    id: EntityIdSchema,
    preparedId: EntityIdSchema,
    platform: EntityIdSchema,
    accountId: EntityIdSchema,
    deliveryMode: DeliveryModeSchema,
    idempotencyKey: PublishIdempotencyKeySchema,
    remoteId: z.string().min(1).nullable(),
    status: SubmissionStatusMetadataSchema.nullable(),
    submittedAt: IsoDateTimeSchema,
  })
  .strict();

export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

export const RemotePublicationStatusSchema = z
  .object({
    state: RemotePublicationStateSchema,
    remoteId: z.string().min(1).nullable(),
    url: z.string().url().nullable(),
    message: z.string().min(1).nullable(),
    checkedAt: IsoDateTimeSchema,
  })
  .strict();

export type RemotePublicationStatus = z.infer<typeof RemotePublicationStatusSchema>;

export const AssistedSessionSchema = z
  .object({
    id: EntityIdSchema,
    preparedId: EntityIdSchema,
    status: z.enum(['OPEN', 'COMPLETED', 'ABORTED']),
    openedAt: IsoDateTimeSchema,
  })
  .strict();

export type AssistedSession = z.infer<typeof AssistedSessionSchema>;

export interface PlatformAdapter {
  probeCapabilities(accountId: string): Promise<AccountCapabilities>;
  validate(revisionId: string, target: PublishTarget): Promise<ValidationIssue[]>;
  prepare(revisionId: string, target: PublishTarget): Promise<PreparedPublication>;
  submit(preparedId: string): Promise<SubmissionReceipt>;
  poll?(receipt: SubmissionReceipt): Promise<RemotePublicationStatus>;
  openAssistedFlow?(preparedId: string): Promise<AssistedSession>;
}
