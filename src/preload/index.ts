import { contextBridge, ipcRenderer } from 'electron';

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
  publishJobListDtoSchema,
  publishPlanResultDtoSchema,
  reviseContentRequestSchema,
  saveAccountRequestSchema,
  saveAiProfileRequestSchema,
  type OmniPostApi,
} from '../shared/ipc.js';

const omniPostApi: OmniPostApi = {
  getMetadata: async () => appMetadataSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getMetadata)),
  listContent: async () => contentDocumentListDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.listContent),
  ),
  createContent: async (value) => contentDocumentDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.createContent, createContentRequestSchema.parse(value)),
  ),
  reviseContent: async (value) => contentDocumentDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.reviseContent, reviseContentRequestSchema.parse(value)),
  ),
  discoverImports: async (importer) => importDiscoveryDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.discoverImports, importerChoiceSchema.parse(importer)),
  ),
  previewImport: async (candidateId) => importPreviewDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.previewImport, candidateId),
  ),
  ingestImport: async (candidateId) => contentDocumentDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.ingestImport, candidateId),
  ),
  listAccounts: async () => accountConnectionListDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.listAccounts),
  ),
  saveAccount: async (input) => accountConnectionDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.saveAccount, saveAccountRequestSchema.parse(input)),
  ),
  listPublishJobs: async () => publishJobListDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.listPublishJobs),
  ),
  createPublishPlan: async (input) => publishPlanResultDtoSchema.parse(
    await ipcRenderer.invoke(
      IPC_CHANNELS.createPublishPlan,
      createPublishPlanRequestSchema.parse(input),
    ),
  ),
  approvePublishPlan: async (planId) => publishPlanResultDtoSchema.parse(
    await ipcRenderer.invoke(
      IPC_CHANNELS.approvePublishPlan,
      approvePublishPlanRequestSchema.parse({ planId }),
    ),
  ),
  getAiProfile: async () => aiProfileResultDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.getAiProfile),
  ),
  saveAiProfile: async (input) => aiProfileDtoSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.saveAiProfile, saveAiProfileRequestSchema.parse(input)),
  ),
  generateAiVariant: async (input) => aiVariantResultDtoSchema.parse(
    await ipcRenderer.invoke(
      IPC_CHANNELS.generateAiVariant,
      generateAiVariantRequestSchema.parse(input),
    ),
  ),
  exportManualHandoff: async (input) => manualHandoffExportResultSchema.parse(
    await ipcRenderer.invoke(
      IPC_CHANNELS.exportManualHandoff,
      manualHandoffExportRequestSchema.parse(input),
    ),
  ),
  openManualEditor: async (platform) => {
    await ipcRenderer.invoke(IPC_CHANNELS.openManualEditor, platform);
  },
  getDiagnostics: async () => diagnosticsSummarySchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.getDiagnostics),
  ),
  exportDiagnosticLog: async () => diagnosticLogExportResultSchema.parse(
    await ipcRenderer.invoke(IPC_CHANNELS.exportDiagnosticLog),
  ),
  openRunArtifacts: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.openRunArtifacts);
  },
  getAutoStart: async () => Boolean(await ipcRenderer.invoke(IPC_CHANNELS.getAutoStart)),
  setAutoStart: async (enabled) => Boolean(
    await ipcRenderer.invoke(IPC_CHANNELS.setAutoStart, enabled),
  ),
};

contextBridge.exposeInMainWorld('omniPost', omniPostApi);
