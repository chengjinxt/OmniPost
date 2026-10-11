import { z } from 'zod';

import { APP_METADATA } from '../shared/app-metadata.js';
import {
  IPC_CHANNELS,
  accountConnectionDtoSchema,
  accountConnectionListDtoSchema,
  aiProfileDtoSchema,
  aiProfileResultDtoSchema,
  aiVariantResultDtoSchema,
  approvePublishPlanRequestSchema,
  appMetadataSchema,
  contentDocumentDtoSchema,
  contentDocumentListDtoSchema,
  createContentRequestSchema,
  createPublishPlanRequestSchema,
  diagnosticLogExportResultSchema,
  diagnosticsSummarySchema,
  generateAiVariantRequestSchema,
  importDiscoveryDtoSchema,
  importPreviewDtoSchema,
  importerChoiceSchema,
  manualHandoffExportRequestSchema,
  manualHandoffExportResultSchema,
  publishJobDtoSchema,
  publishJobListDtoSchema,
  publishPlanResultDtoSchema,
  reviseContentRequestSchema,
  saveAccountRequestSchema,
  saveAiProfileRequestSchema,
  type ContentDocumentDto,
  type SaveAccountRequest,
  type SaveAiProfileRequest,
  type GenerateAiVariantRequest,
} from '../shared/ipc.js';
import type {
  ContentDocument,
  CreateContentInput,
  ReviseContentInput,
} from './infrastructure/content-repository.js';
import type { PublishJob, PublishPlan } from '../domain/index.js';

export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown): void;
}

export interface ContentService {
  list(): ContentDocument[];
  create(input: CreateContentInput): ContentDocument;
  revise(itemId: string, input: ReviseContentInput): ContentDocument;
}

export interface AutoStartService {
  get(): boolean;
  set(enabled: boolean): void;
}

export interface ImportIpcService {
  discover(importer: 'markdown' | 'tgexporter' | 'knowcraft'): Promise<unknown>;
  preview(candidateId: string): Promise<unknown>;
  ingest(candidateId: string): Promise<ContentDocument>;
}

export interface ApplicationIpcDependencies {
  ipc: IpcRegistrar;
  content: ContentService;
  imports: ImportIpcService;
  accounts: AccountService;
  publishing: PublishingIpcService;
  ai: AiIpcService;
  manualHandoff: ManualHandoffIpcService;
  diagnostics: DiagnosticsIpcService;
  autoStart: AutoStartService;
}

export interface AccountService {
  list(): AccountServiceResult[];
  save(input: SaveAccountRequest): AccountServiceResult;
}

interface AccountServiceResult {
  id: string;
  platform: string;
  externalAccountId: string | null;
  displayName: string;
  deliveryMode: string;
  enabled: boolean;
  capabilitiesCheckedAt: string | null;
  credentialNames: string[];
}

export interface PublishingIpcService {
  listJobs(): PublishJob[];
  createPlan(input: {
    revisionId: string;
    accountIds: string[];
    scheduledAt: string | null;
    platformFieldsByAccount?: Record<string, Record<string, unknown>> | undefined;
  }): { plan: PublishPlanSnapshot; jobs: PublishJob[] };
  approve(planId: string): { plan: PublishPlanSnapshot; jobs: PublishJob[] };
}

type PublishPlanSnapshot = Pick<
  PublishPlan,
  'id' | 'revisionId' | 'variantIds' | 'contentHash' | 'targets'
>;

interface AiProfileResult {
  configured: true;
  baseUrl: string;
  baseUrlId: string;
  model: string;
  endpoint: 'RESPONSES' | 'CHAT_COMPLETIONS';
  promptVersion: string;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface AiIpcService {
  getProfile(): AiProfileResult | null;
  saveProfile(input: SaveAiProfileRequest): AiProfileResult;
  generate(input: GenerateAiVariantRequest): Promise<{
    variant: {
      id: string;
      revisionId: string;
      platform: string;
      title: string | null;
      bodyMarkdown: string | null;
      contentHash: string;
      createdAt: string;
    };
    generation: {
      model: string;
      promptVersion: string;
      createdAt: string;
    };
  }>;
}

export interface ManualHandoffIpcService {
  export(input: {
    revisionId: string;
    platform: 'MEDIUM';
    format: 'MARKDOWN' | 'HTML';
    canonicalUrl: string | null;
  }): Promise<{ cancelled: boolean; suggestedName: string }>;
  openEditor(platform: 'MEDIUM'): Promise<void>;
}

export interface DiagnosticsIpcService {
  getSummary(): Promise<{
    retentionDays: number;
    logBytes: number;
    artifactCount: number;
    latestArtifactAt: string | null;
  }>;
  exportLog(): Promise<{ cancelled: boolean; fileName: string }>;
  openArtifacts(): Promise<void>;
}

function toDto(document: ContentDocument): ContentDocumentDto {
  return contentDocumentDtoSchema.parse({
    itemId: document.item.id,
    revisionId: document.revision.id,
    revisionNumber: document.revision.revisionNumber,
    kind: document.revision.kind,
    title: document.revision.title,
    bodyMarkdown: document.revision.bodyMarkdown,
    contentHash: document.revision.contentHash,
    updatedAt: document.item.updatedAt,
  });
}

function toAccountDto(account: AccountServiceResult) {
  return accountConnectionDtoSchema.parse({
    id: account.id,
    platform: account.platform,
    displayName: account.displayName,
    externalAccountId: account.externalAccountId,
    deliveryMode: account.deliveryMode,
    enabled: account.enabled,
    credentialNames: account.credentialNames,
    capabilitiesCheckedAt: account.capabilitiesCheckedAt,
  });
}

function toPublishJobDto(job: PublishJob) {
  return publishJobDtoSchema.parse({
    id: job.id,
    planId: job.planId,
    revisionId: job.revisionId,
    accountId: job.accountId,
    platform: job.platform,
    deliveryMode: job.deliveryMode,
    state: job.state,
    scheduledAt: job.scheduledAt,
    attemptCount: job.attemptCount,
    statusMessage: job.statusMessage,
    updatedAt: job.updatedAt,
  });
}

function toPublishPlanResult(result: { plan: PublishPlanSnapshot; jobs: PublishJob[] }) {
  return publishPlanResultDtoSchema.parse({
    planId: result.plan.id,
    revisionId: result.plan.revisionId,
    variantIds: result.plan.variantIds,
    contentHash: result.plan.contentHash,
    targets: result.plan.targets,
    jobs: result.jobs.map(toPublishJobDto),
  });
}

export function registerApplicationIpc(dependencies: ApplicationIpcDependencies): void {
  dependencies.ipc.handle(IPC_CHANNELS.getMetadata, async () => appMetadataSchema.parse(APP_METADATA));

  dependencies.ipc.handle(IPC_CHANNELS.listContent, async () => (
    contentDocumentListDtoSchema.parse(dependencies.content.list().map(toDto))
  ));

  dependencies.ipc.handle(IPC_CHANNELS.createContent, async (_event, value) => {
    const input = createContentRequestSchema.parse(value);
    return toDto(dependencies.content.create({
      ...input,
      media: [],
      sourceHash: null,
      sourceType: 'MANUAL',
    }));
  });

  dependencies.ipc.handle(IPC_CHANNELS.reviseContent, async (_event, value) => {
    const input = reviseContentRequestSchema.parse(value);
    return toDto(dependencies.content.revise(input.itemId, {
      kind: input.kind,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
    }));
  });

  dependencies.ipc.handle(IPC_CHANNELS.discoverImports, async (_event, value) => {
    const importer = importerChoiceSchema.parse(value);
    return importDiscoveryDtoSchema.parse(await dependencies.imports.discover(importer));
  });

  dependencies.ipc.handle(IPC_CHANNELS.previewImport, async (_event, value) => {
    const candidateId = z.string().trim().min(1).max(200).parse(value);
    return importPreviewDtoSchema.parse(await dependencies.imports.preview(candidateId));
  });

  dependencies.ipc.handle(IPC_CHANNELS.ingestImport, async (_event, value) => {
    const candidateId = z.string().trim().min(1).max(200).parse(value);
    return toDto(await dependencies.imports.ingest(candidateId));
  });

  dependencies.ipc.handle(IPC_CHANNELS.listAccounts, async () => (
    accountConnectionListDtoSchema.parse(dependencies.accounts.list().map(toAccountDto))
  ));

  dependencies.ipc.handle(IPC_CHANNELS.saveAccount, async (_event, value) => {
    const input = saveAccountRequestSchema.parse(value);
    return toAccountDto(dependencies.accounts.save(input));
  });

  dependencies.ipc.handle(IPC_CHANNELS.listPublishJobs, async () => (
    publishJobListDtoSchema.parse(dependencies.publishing.listJobs().map(toPublishJobDto))
  ));

  dependencies.ipc.handle(IPC_CHANNELS.createPublishPlan, async (_event, value) => {
    const input = createPublishPlanRequestSchema.parse(value);
    return toPublishPlanResult(dependencies.publishing.createPlan(input));
  });

  dependencies.ipc.handle(IPC_CHANNELS.approvePublishPlan, async (_event, value) => {
    const input = approvePublishPlanRequestSchema.parse(value);
    return toPublishPlanResult(dependencies.publishing.approve(input.planId));
  });

  dependencies.ipc.handle(IPC_CHANNELS.getAiProfile, async () => (
    aiProfileResultDtoSchema.parse(dependencies.ai.getProfile())
  ));

  dependencies.ipc.handle(IPC_CHANNELS.saveAiProfile, async (_event, value) => {
    const input = saveAiProfileRequestSchema.parse(value);
    return aiProfileDtoSchema.parse(dependencies.ai.saveProfile(input));
  });

  dependencies.ipc.handle(IPC_CHANNELS.generateAiVariant, async (_event, value) => {
    const input = generateAiVariantRequestSchema.parse(value);
    const result = await dependencies.ai.generate(input);
    return aiVariantResultDtoSchema.parse({
      variantId: result.variant.id,
      revisionId: result.variant.revisionId,
      platform: result.variant.platform,
      title: result.variant.title,
      bodyMarkdown: result.variant.bodyMarkdown,
      contentHash: result.variant.contentHash,
      model: result.generation.model,
      promptVersion: result.generation.promptVersion,
      createdAt: result.generation.createdAt,
    });
  });

  dependencies.ipc.handle(IPC_CHANNELS.exportManualHandoff, async (_event, value) => {
    const input = manualHandoffExportRequestSchema.parse(value);
    return manualHandoffExportResultSchema.parse(await dependencies.manualHandoff.export(input));
  });

  dependencies.ipc.handle(IPC_CHANNELS.openManualEditor, async (_event, value) => {
    const platform = z.literal('MEDIUM').parse(value);
    await dependencies.manualHandoff.openEditor(platform);
  });

  dependencies.ipc.handle(IPC_CHANNELS.getDiagnostics, async () => (
    diagnosticsSummarySchema.parse(await dependencies.diagnostics.getSummary())
  ));

  dependencies.ipc.handle(IPC_CHANNELS.exportDiagnosticLog, async () => (
    diagnosticLogExportResultSchema.parse(await dependencies.diagnostics.exportLog())
  ));

  dependencies.ipc.handle(IPC_CHANNELS.openRunArtifacts, async () => {
    await dependencies.diagnostics.openArtifacts();
  });

  dependencies.ipc.handle(IPC_CHANNELS.getAutoStart, async () => dependencies.autoStart.get());
  dependencies.ipc.handle(IPC_CHANNELS.setAutoStart, async (_event, value) => {
    const enabled = z.boolean().parse(value);
    dependencies.autoStart.set(enabled);
    return dependencies.autoStart.get();
  });
}
