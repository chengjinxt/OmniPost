import { z } from 'zod';

export const IPC_CHANNELS = {
  getMetadata: 'app:get-metadata',
  listContent: 'content:list',
  createContent: 'content:create',
  reviseContent: 'content:revise',
  discoverImports: 'imports:discover',
  previewImport: 'imports:preview',
  ingestImport: 'imports:ingest',
  listAccounts: 'accounts:list',
  saveAccount: 'accounts:save',
  listPublishJobs: 'publishing:list-jobs',
  createPublishPlan: 'publishing:create-plan',
  approvePublishPlan: 'publishing:approve-plan',
  getAiProfile: 'ai:get-profile',
  saveAiProfile: 'ai:save-profile',
  generateAiVariant: 'ai:generate-variant',
  exportManualHandoff: 'handoff:export',
  openManualEditor: 'handoff:open-editor',
  getDiagnostics: 'diagnostics:get-summary',
  exportDiagnosticLog: 'diagnostics:export-log',
  openRunArtifacts: 'diagnostics:open-artifacts',
  getAutoStart: 'settings:get-auto-start',
  setAutoStart: 'settings:set-auto-start',
} as const;

export const appMetadataSchema = z.object({
  name: z.literal('OmniPost'),
  tagline: z.string().min(1),
  defaultLocale: z.literal('zh-CN'),
  defaultTimeZone: z.literal('Asia/Shanghai'),
});

export type AppMetadata = z.infer<typeof appMetadataSchema>;

export const contentKindDtoSchema = z.enum(['ARTICLE', 'IMAGE_POST', 'VIDEO']);

export const createContentRequestSchema = z.object({
  kind: contentKindDtoSchema,
  title: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().max(2_000_000),
}).strict();

export const reviseContentRequestSchema = createContentRequestSchema.extend({
  itemId: z.string().trim().min(1),
}).strict();

export const contentDocumentDtoSchema = z.object({
  itemId: z.string().min(1),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  kind: contentKindDtoSchema,
  title: z.string(),
  bodyMarkdown: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const contentDocumentListDtoSchema = z.array(contentDocumentDtoSchema);

export const importerChoiceSchema = z.enum(['markdown', 'tgexporter', 'knowcraft']);

export const importCandidateDtoSchema = z.object({
  id: z.string().min(1),
  importer: importerChoiceSchema,
  kind: contentKindDtoSchema,
  title: z.string(),
  relativePath: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const importDiscoveryDtoSchema = z.object({
  cancelled: z.boolean(),
  candidates: z.array(importCandidateDtoSchema),
}).strict();

export const importPreviewDtoSchema = z.object({
  candidateId: z.string().min(1),
  title: z.string(),
  bodyMarkdown: z.string(),
  media: z.array(z.object({
    originalName: z.string().min(1),
    kind: z.enum(['IMAGE_POST', 'VIDEO']),
    order: z.number().int().nonnegative(),
  }).strict()),
  warnings: z.array(z.string()),
}).strict();

export const platformIdDtoSchema = z.enum([
  'WECHAT_OFFICIAL_ACCOUNT',
  'WECHAT_CHANNELS',
  'DOUYIN',
  'TOUTIAO',
  'XIAOHONGSHU',
  'KUAISHOU',
  'YOUTUBE',
  'BAIJIAHAO',
  'CSDN',
  'JUEJIN',
  'ZHIHU',
  'SUBSTACK',
  'MEDIUM',
]);

export const deliveryModeDtoSchema = z.enum([
  'DIRECT_API',
  'REMOTE_DRAFT',
  'ASSISTED_BROWSER',
  'MANUAL_HANDOFF',
  'UNSUPPORTED',
]);

export const capabilityContextDtoSchema = z.object({
  qualifications: z.array(z.string().min(1)),
  scopes: z.array(z.string().min(1)),
  probes: z.object({
    directApi: z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']),
    remoteDraft: z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']),
    assistedBrowser: z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']),
  }).strict(),
}).strict();

export const saveAccountRequestSchema = z.object({
  id: z.string().min(1).optional(),
  platform: platformIdDtoSchema,
  displayName: z.string().trim().min(1).max(120),
  externalAccountId: z.string().trim().min(1).nullable(),
  deliveryMode: deliveryModeDtoSchema,
  credentials: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
    z.string().min(1),
  ),
  capabilityContext: capabilityContextDtoSchema.optional(),
}).strict();

export const accountConnectionDtoSchema = z.object({
  id: z.string().min(1),
  platform: platformIdDtoSchema,
  displayName: z.string().min(1),
  externalAccountId: z.string().min(1).nullable(),
  deliveryMode: deliveryModeDtoSchema,
  enabled: z.boolean(),
  credentialNames: z.array(z.string().min(1)),
  capabilitiesCheckedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const accountConnectionListDtoSchema = z.array(accountConnectionDtoSchema);

export const jobStateDtoSchema = z.enum([
  'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PREPARING',
  'SUBMITTED', 'PROCESSING', 'PUBLISHED', 'REJECTED', 'NEEDS_ACTION',
  'FAILED', 'UNKNOWN', 'CANCELLED',
]);

export const createPublishPlanRequestSchema = z.object({
  revisionId: z.string().min(1),
  accountIds: z.array(z.string().min(1)).min(1),
  scheduledAt: z.string().datetime({ offset: true }).nullable(),
  platformFieldsByAccount: z.record(
    z.string().min(1),
    z.record(z.string(), z.json()),
  ).optional(),
}).strict();

export const approvePublishPlanRequestSchema = z.object({
  planId: z.string().min(1),
}).strict();

export const publishJobDtoSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  revisionId: z.string().min(1),
  accountId: z.string().min(1),
  platform: platformIdDtoSchema,
  deliveryMode: deliveryModeDtoSchema,
  state: jobStateDtoSchema,
  scheduledAt: z.string().datetime({ offset: true }).nullable(),
  attemptCount: z.number().int().nonnegative(),
  statusMessage: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const publishJobListDtoSchema = z.array(publishJobDtoSchema);
export const publishTargetSnapshotDtoSchema = z.object({
  accountId: z.string().min(1),
  platform: platformIdDtoSchema,
  deliveryMode: deliveryModeDtoSchema,
  scheduledAt: z.string().datetime({ offset: true }).nullable(),
  platformFields: z.record(z.string(), z.json()),
}).strict();
export const publishPlanResultDtoSchema = z.object({
  planId: z.string().min(1),
  revisionId: z.string().min(1),
  variantIds: z.array(z.string().min(1)),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(publishTargetSnapshotDtoSchema).min(1),
  jobs: publishJobListDtoSchema,
}).strict();

export const saveAiProfileRequestSchema = z.object({
  baseUrl: z.string().url(),
  baseUrlId: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  endpoint: z.enum(['RESPONSES', 'CHAT_COMPLETIONS']),
  promptVersion: z.string().trim().min(1).max(120),
  apiKey: z.string().min(1).nullable(),
}).strict();

export const aiProfileDtoSchema = z.object({
  configured: z.literal(true),
  baseUrl: z.string().url(),
  baseUrlId: z.string().min(1),
  model: z.string().min(1),
  endpoint: z.enum(['RESPONSES', 'CHAT_COMPLETIONS']),
  promptVersion: z.string().min(1),
  hasApiKey: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const aiProfileResultDtoSchema = aiProfileDtoSchema.nullable();

const aiConstraintValueSchema = z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(z.string()),
]);
export const generateAiVariantRequestSchema = z.object({
  revisionId: z.string().min(1),
  platform: platformIdDtoSchema,
  constraints: z.record(z.string(), aiConstraintValueSchema),
}).strict();

export const aiVariantResultDtoSchema = z.object({
  variantId: z.string().min(1),
  revisionId: z.string().min(1),
  platform: platformIdDtoSchema,
  title: z.string().nullable(),
  bodyMarkdown: z.string().nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const manualHandoffExportRequestSchema = z.object({
  revisionId: z.string().min(1),
  platform: z.literal('MEDIUM'),
  format: z.enum(['MARKDOWN', 'HTML']),
  canonicalUrl: z.string().url().nullable(),
}).strict();
export const manualHandoffExportResultSchema = z.object({
  cancelled: z.boolean(),
  suggestedName: z.string().min(1),
}).strict();

export const diagnosticsSummarySchema = z.object({
  retentionDays: z.number().int().positive(),
  logBytes: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  latestArtifactAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const diagnosticLogExportResultSchema = z.object({
  cancelled: z.boolean(),
  fileName: z.string().min(1),
}).strict();

export type CreateContentRequest = z.infer<typeof createContentRequestSchema>;
export type ReviseContentRequest = z.infer<typeof reviseContentRequestSchema>;
export type ContentDocumentDto = z.infer<typeof contentDocumentDtoSchema>;
export type ImporterChoice = z.infer<typeof importerChoiceSchema>;
export type ImportCandidateDto = z.infer<typeof importCandidateDtoSchema>;
export type ImportDiscoveryDto = z.infer<typeof importDiscoveryDtoSchema>;
export type ImportPreviewDto = z.infer<typeof importPreviewDtoSchema>;
export type SaveAccountRequest = z.infer<typeof saveAccountRequestSchema>;
export type AccountConnectionDto = z.infer<typeof accountConnectionDtoSchema>;
export type CreatePublishPlanRequest = z.infer<typeof createPublishPlanRequestSchema>;
export type PublishJobDto = z.infer<typeof publishJobDtoSchema>;
export type PublishPlanResultDto = z.infer<typeof publishPlanResultDtoSchema>;
export type SaveAiProfileRequest = z.infer<typeof saveAiProfileRequestSchema>;
export type AiProfileDto = z.infer<typeof aiProfileDtoSchema>;
export type GenerateAiVariantRequest = z.infer<typeof generateAiVariantRequestSchema>;
export type AiVariantResultDto = z.infer<typeof aiVariantResultDtoSchema>;
export type ManualHandoffExportRequest = z.infer<typeof manualHandoffExportRequestSchema>;
export type ManualHandoffExportResult = z.infer<typeof manualHandoffExportResultSchema>;
export type DiagnosticsSummaryDto = z.infer<typeof diagnosticsSummarySchema>;
export type DiagnosticLogExportResult = z.infer<typeof diagnosticLogExportResultSchema>;

export interface OmniPostApi {
  getMetadata(): Promise<AppMetadata>;
  listContent(): Promise<ContentDocumentDto[]>;
  createContent(input: CreateContentRequest): Promise<ContentDocumentDto>;
  reviseContent(input: ReviseContentRequest): Promise<ContentDocumentDto>;
  discoverImports(importer: ImporterChoice): Promise<ImportDiscoveryDto>;
  previewImport(candidateId: string): Promise<ImportPreviewDto>;
  ingestImport(candidateId: string): Promise<ContentDocumentDto>;
  listAccounts(): Promise<AccountConnectionDto[]>;
  saveAccount(input: SaveAccountRequest): Promise<AccountConnectionDto>;
  listPublishJobs(): Promise<PublishJobDto[]>;
  createPublishPlan(input: CreatePublishPlanRequest): Promise<PublishPlanResultDto>;
  approvePublishPlan(planId: string): Promise<PublishPlanResultDto>;
  getAiProfile(): Promise<AiProfileDto | null>;
  saveAiProfile(input: SaveAiProfileRequest): Promise<AiProfileDto>;
  generateAiVariant(input: GenerateAiVariantRequest): Promise<AiVariantResultDto>;
  exportManualHandoff(input: ManualHandoffExportRequest): Promise<ManualHandoffExportResult>;
  openManualEditor(platform: 'MEDIUM'): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsSummaryDto>;
  exportDiagnosticLog(): Promise<DiagnosticLogExportResult>;
  openRunArtifacts(): Promise<void>;
  getAutoStart(): Promise<boolean>;
  setAutoStart(enabled: boolean): Promise<boolean>;
}
