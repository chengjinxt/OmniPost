import { describe, expect, it, vi } from 'vitest';

import { ContentKind, createContentRevision, type ContentItem } from '../domain/index.js';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { registerApplicationIpc, type IpcRegistrar } from './ipc-handlers.js';

describe('registerApplicationIpc', () => {
  it('validates renderer input before invoking the content service', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => { handlers.set(channel, listener); },
    };
    const create = vi.fn(() => documentFixture());
    registerApplicationIpc({
      ipc,
      content: { create, revise: vi.fn(), list: vi.fn(() => []) },
      imports: importServiceFixture(),
      accounts: accountServiceFixture(),
      publishing: publishingServiceFixture(),
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    const handler = handlers.get(IPC_CHANNELS.createContent);
    await expect(handler?.({}, {
      kind: 'ARTICLE',
      title: '标题',
      bodyMarkdown: '正文',
      approval: true,
    })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns renderer-safe immutable revision data', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: {
        create: vi.fn(() => documentFixture()),
        revise: vi.fn(() => documentFixture()),
        list: vi.fn(() => [documentFixture()]),
      },
      imports: importServiceFixture(),
      accounts: accountServiceFixture(),
      publishing: publishingServiceFixture(),
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    await expect(handlers.get(IPC_CHANNELS.listContent)?.({})).resolves.toEqual([{
      itemId: 'item-1',
      revisionId: 'revision-1',
      revisionNumber: 1,
      kind: 'ARTICLE',
      title: '标题',
      bodyMarkdown: '正文',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      updatedAt: '2026-10-12T00:00:00.000Z',
    }]);
  });

  it('only accepts a known importer choice and an opaque candidate id', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const imports = importServiceFixture();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: { create: vi.fn(), revise: vi.fn(), list: vi.fn(() => []) },
      imports,
      accounts: accountServiceFixture(),
      publishing: publishingServiceFixture(),
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    await expect(handlers.get(IPC_CHANNELS.discoverImports)?.({}, 'filesystem'))
      .rejects.toThrow();
    expect(imports.discover).not.toHaveBeenCalled();
    await expect(handlers.get(IPC_CHANNELS.previewImport)?.({}, 'candidate-1'))
      .resolves.toMatchObject({ candidateId: 'candidate-1' });
    expect(imports.preview).toHaveBeenCalledWith('candidate-1');
  });

  it('accepts account credentials only on write and strips them from replies', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const accounts = accountServiceFixture();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: { create: vi.fn(), revise: vi.fn(), list: vi.fn(() => []) },
      imports: importServiceFixture(),
      accounts,
      publishing: publishingServiceFixture(),
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    const result = await handlers.get(IPC_CHANNELS.saveAccount)?.({}, {
      platform: 'YOUTUBE',
      displayName: '频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      credentials: { accessToken: 'secret' },
    });

    expect(accounts.save).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessToken: 'secret' },
    }));
    expect(result).not.toHaveProperty('credentials');
  });

  it('creates an awaiting-approval plan and approves it in a separate call', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const publishing = publishingServiceFixture();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: { create: vi.fn(), revise: vi.fn(), list: vi.fn(() => []) },
      imports: importServiceFixture(),
      accounts: accountServiceFixture(),
      publishing,
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    await expect(handlers.get(IPC_CHANNELS.createPublishPlan)?.({}, {
      revisionId: 'revision-1', accountIds: ['account-1'], scheduledAt: null,
    })).resolves.toMatchObject({
      planId: 'plan-1',
      contentHash: 'b'.repeat(64),
      targets: [{ platformFields: { title: 'Approved snapshot title' } }],
      jobs: [{ state: 'AWAITING_APPROVAL' }],
    });
    await expect(handlers.get(IPC_CHANNELS.approvePublishPlan)?.({}, { planId: 'plan-1' }))
      .resolves.toMatchObject({ planId: 'plan-1', jobs: [{ state: 'APPROVED' }] });
    expect(publishing.approve).toHaveBeenCalledWith('plan-1');
  });

  it('keeps the AI key write-only and returns persisted variant provenance', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const ai = aiServiceFixture();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: { create: vi.fn(), revise: vi.fn(), list: vi.fn(() => []) },
      imports: importServiceFixture(),
      accounts: accountServiceFixture(),
      publishing: publishingServiceFixture(),
      ai,
      manualHandoff: manualHandoffFixture(),
      diagnostics: diagnosticsFixture(),
      autoStart: { get: () => false, set: vi.fn() },
    });

    const profile = await handlers.get(IPC_CHANNELS.saveAiProfile)?.({}, {
      baseUrl: 'https://api.example.com/v1', baseUrlId: 'primary', model: 'writer-1',
      endpoint: 'RESPONSES', promptVersion: 'platform-v1', apiKey: 'secret',
    });
    expect(ai.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'secret' }));
    expect(profile).not.toHaveProperty('apiKey');
    await expect(handlers.get(IPC_CHANNELS.generateAiVariant)?.({}, {
      revisionId: 'revision-1', platform: 'ZHIHU', constraints: {},
    })).resolves.toMatchObject({ variantId: 'variant-1', model: 'writer-1' });
  });

  it('exposes only diagnostics summaries and explicit user actions', async () => {
    const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const diagnostics = diagnosticsFixture();
    registerApplicationIpc({
      ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      content: { create: vi.fn(), revise: vi.fn(), list: vi.fn(() => []) },
      imports: importServiceFixture(),
      accounts: accountServiceFixture(),
      publishing: publishingServiceFixture(),
      ai: aiServiceFixture(),
      manualHandoff: manualHandoffFixture(),
      diagnostics,
      autoStart: { get: () => false, set: vi.fn() },
    });

    await expect(handlers.get(IPC_CHANNELS.getDiagnostics)?.({})).resolves.toEqual({
      retentionDays: 30,
      logBytes: 128,
      artifactCount: 2,
      latestArtifactAt: null,
    });
    await expect(handlers.get(IPC_CHANNELS.exportDiagnosticLog)?.({})).resolves.toEqual({
      cancelled: false,
      fileName: 'omnipost-diagnostics.jsonl',
    });
    await expect(handlers.get(IPC_CHANNELS.openRunArtifacts)?.({})).resolves.toBeUndefined();
    expect(diagnostics.exportLog).toHaveBeenCalledOnce();
    expect(diagnostics.openArtifacts).toHaveBeenCalledOnce();
  });
});

function importServiceFixture() {
  return {
    discover: vi.fn().mockResolvedValue({ cancelled: true, candidates: [] }),
    preview: vi.fn().mockResolvedValue({
      candidateId: 'candidate-1',
      title: '预览',
      bodyMarkdown: '正文',
      media: [],
      warnings: [],
    }),
    ingest: vi.fn().mockResolvedValue(documentFixture()),
  };
}

function accountServiceFixture() {
  const account = {
    id: 'account-1',
    platform: 'YOUTUBE',
    externalAccountId: null,
    displayName: '频道',
    deliveryMode: 'DIRECT_API' as const,
    credentialRef: 'safeStorage:account-1',
    enabled: true,
    capabilitiesCheckedAt: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    credentialNames: ['accessToken'],
  };
  return { list: vi.fn(() => [account]), save: vi.fn(() => account) };
}

function publishingServiceFixture() {
  const job = (state: 'AWAITING_APPROVAL' | 'APPROVED') => ({
    id: 'job-1',
    planId: 'plan-1',
    revisionId: 'revision-1',
    variantId: null,
    accountId: 'account-1',
    platform: 'YOUTUBE',
    deliveryMode: 'DIRECT_API' as const,
    state,
    idempotencyKey: `publish_${'a'.repeat(64)}`,
    scheduledAt: null,
    attemptCount: 0,
    remotePublicationId: null,
    statusMessage: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  });
  return {
    listJobs: vi.fn(() => [job('AWAITING_APPROVAL')]),
    createPlan: vi.fn(() => ({ plan: planFixture(), jobs: [job('AWAITING_APPROVAL')] })),
    approve: vi.fn(() => ({ plan: planFixture(), jobs: [job('APPROVED')] })),
  };
}

function planFixture() {
  return {
    id: 'plan-1',
    revisionId: 'revision-1',
    variantIds: ['variant-1'],
    contentHash: 'b'.repeat(64),
    targets: [{
      accountId: 'account-1',
      platform: 'YOUTUBE',
      deliveryMode: 'DIRECT_API' as const,
      scheduledAt: null,
      platformFields: {
        title: 'Approved snapshot title',
        bodyMarkdown: 'Approved snapshot body',
      },
    }],
  };
}

function aiServiceFixture() {
  const profile = {
    configured: true as const,
    baseUrl: 'https://api.example.com/v1',
    baseUrlId: 'primary',
    model: 'writer-1',
    endpoint: 'RESPONSES' as const,
    promptVersion: 'platform-v1',
    hasApiKey: true,
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
  return {
    getProfile: vi.fn(() => profile),
    saveProfile: vi.fn(() => profile),
    generate: vi.fn().mockResolvedValue({
      variant: {
        id: 'variant-1', revisionId: 'revision-1', platform: 'ZHIHU',
        title: '知乎标题', bodyMarkdown: null, media: null, platformFields: {},
        contentHash: 'a'.repeat(64), createdAt: '2026-10-12T00:00:00.000Z',
      },
      generation: {
        variantId: 'variant-1', model: 'writer-1', baseUrlId: 'primary',
        promptVersion: 'platform-v1', requestHash: 'b'.repeat(64),
        responseHash: 'c'.repeat(64), createdAt: '2026-10-12T00:00:00.000Z',
      },
    }),
  };
}

function manualHandoffFixture() {
  return {
    export: vi.fn().mockResolvedValue({ cancelled: false, suggestedName: 'article-medium.md' }),
    openEditor: vi.fn().mockResolvedValue(undefined),
  };
}

function diagnosticsFixture() {
  return {
    getSummary: vi.fn().mockResolvedValue({
      retentionDays: 30,
      logBytes: 128,
      artifactCount: 2,
      latestArtifactAt: null,
    }),
    exportLog: vi.fn().mockResolvedValue({
      cancelled: false,
      fileName: 'omnipost-diagnostics.jsonl',
    }),
    openArtifacts: vi.fn().mockResolvedValue(undefined),
  };
}

function documentFixture() {
  const revision = createContentRevision({
    id: 'revision-1',
    contentItemId: 'item-1',
    revisionNumber: 1,
    kind: ContentKind.ARTICLE,
    title: '标题',
    bodyMarkdown: '正文',
    media: [],
    sourceHash: null,
    createdAt: '2026-10-12T00:00:00.000Z',
  });
  const item: ContentItem = {
    id: 'item-1',
    kind: ContentKind.ARTICLE,
    title: '标题',
    currentRevisionId: 'revision-1',
    source: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
  return { item, revision };
}
