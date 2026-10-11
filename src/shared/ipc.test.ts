import { describe, expect, it } from 'vitest';

import {
  contentDocumentDtoSchema,
  createContentRequestSchema,
  accountConnectionDtoSchema,
  importDiscoveryDtoSchema,
  importPreviewDtoSchema,
  importerChoiceSchema,
  saveAccountRequestSchema,
  createPublishPlanRequestSchema,
  publishJobDtoSchema,
  reviseContentRequestSchema,
  saveAiProfileRequestSchema,
  aiProfileDtoSchema,
  generateAiVariantRequestSchema,
  aiVariantResultDtoSchema,
  manualHandoffExportRequestSchema,
  diagnosticsSummarySchema,
} from './ipc.js';

describe('content IPC schemas', () => {
  it('accepts a validated create request and rejects unexpected fields', () => {
    const request = {
      kind: 'ARTICLE',
      title: '跨平台内容',
      bodyMarkdown: '# 正文',
    };

    expect(createContentRequestSchema.parse(request)).toEqual(request);
    expect(() => createContentRequestSchema.parse({ ...request, approval: true })).toThrow();
  });

  it('requires an explicit content item for revisions', () => {
    expect(() => reviseContentRequestSchema.parse({
      kind: 'ARTICLE',
      title: '第二稿',
      bodyMarkdown: '内容',
    })).toThrow();
  });

  it('validates immutable revision metadata returned to the renderer', () => {
    expect(contentDocumentDtoSchema.parse({
      itemId: 'item-1',
      revisionId: 'revision-2',
      revisionNumber: 2,
      kind: 'ARTICLE',
      title: '第二稿',
      bodyMarkdown: '内容',
      contentHash: 'a'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    })).toMatchObject({ revisionNumber: 2, title: '第二稿' });
  });

  it('validates readonly import discovery and preview payloads', () => {
    expect(importerChoiceSchema.parse('knowcraft')).toBe('knowcraft');
    expect(() => importerChoiceSchema.parse('arbitrary-path')).toThrow();
    expect(importDiscoveryDtoSchema.parse({
      cancelled: false,
      candidates: [{
        id: 'candidate-1',
        importer: 'tgexporter',
        kind: 'ARTICLE',
        title: '文章',
        relativePath: '第1批/文章.md',
        sourceHash: 'b'.repeat(64),
      }],
    }).candidates).toHaveLength(1);
    expect(() => importPreviewDtoSchema.parse({
      candidateId: 'candidate-1',
      title: '文章',
      bodyMarkdown: '正文',
      media: [],
      warnings: [],
      sourcePath: 'C:/forged/source.md',
    })).toThrow();
  });

  it('accepts account secrets on write but never exposes their values in account DTOs', () => {
    expect(saveAccountRequestSchema.parse({
      platform: 'YOUTUBE',
      displayName: '主频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      credentials: { accessToken: 'secret' },
      capabilityContext: {
        qualifications: [],
        scopes: ['youtube.upload'],
        probes: {
          directApi: 'AVAILABLE',
          remoteDraft: 'UNAVAILABLE',
          assistedBrowser: 'AVAILABLE',
        },
      },
    })).toMatchObject({
      platform: 'YOUTUBE',
      capabilityContext: { scopes: ['youtube.upload'] },
    });
    expect(accountConnectionDtoSchema.parse({
      id: 'account-1',
      platform: 'YOUTUBE',
      displayName: '主频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      enabled: true,
      credentialNames: ['accessToken'],
      capabilitiesCheckedAt: null,
    })).not.toHaveProperty('credentials');
    expect(() => accountConnectionDtoSchema.parse({
      id: 'account-1',
      platform: 'YOUTUBE',
      displayName: '主频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      enabled: true,
      credentialNames: ['accessToken'],
      capabilitiesCheckedAt: null,
      credentials: { accessToken: 'leak' },
    })).toThrow();
  });

  it('validates approval-bound publish plan and job payloads', () => {
    expect(createPublishPlanRequestSchema.parse({
      revisionId: 'revision-1',
      accountIds: ['account-1'],
      scheduledAt: null,
      platformFieldsByAccount: {
        'account-1': { uploadUri: 'file:///content/video.mp4', tags: ['OmniPost'] },
      },
    })).toMatchObject({
      revisionId: 'revision-1',
      platformFieldsByAccount: { 'account-1': { tags: ['OmniPost'] } },
    });
    expect(() => createPublishPlanRequestSchema.parse({
      revisionId: 'revision-1',
      accountIds: [],
      scheduledAt: null,
    })).toThrow();
    expect(publishJobDtoSchema.parse({
      id: 'job-1',
      planId: 'plan-1',
      revisionId: 'revision-1',
      accountId: 'account-1',
      platform: 'YOUTUBE',
      deliveryMode: 'DIRECT_API',
      state: 'AWAITING_APPROVAL',
      scheduledAt: null,
      attemptCount: 0,
      statusMessage: null,
      updatedAt: '2026-10-12T00:00:00.000Z',
    })).toMatchObject({ state: 'AWAITING_APPROVAL' });
  });

  it('keeps AI keys write-only and validates generated variant provenance', () => {
    expect(saveAiProfileRequestSchema.parse({
      baseUrl: 'https://api.example.com/v1',
      baseUrlId: 'primary',
      model: 'writer-1',
      endpoint: 'RESPONSES',
      promptVersion: 'platform-v1',
      apiKey: 'secret',
    })).toMatchObject({ model: 'writer-1' });
    expect(aiProfileDtoSchema.parse({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      baseUrlId: 'primary',
      model: 'writer-1',
      endpoint: 'RESPONSES',
      promptVersion: 'platform-v1',
      hasApiKey: true,
      updatedAt: '2026-10-12T00:00:00.000Z',
    })).not.toHaveProperty('apiKey');
    expect(generateAiVariantRequestSchema.parse({
      revisionId: 'revision-1', platform: 'ZHIHU', constraints: {},
    })).toMatchObject({ platform: 'ZHIHU' });
    expect(aiVariantResultDtoSchema.parse({
      variantId: 'variant-1', revisionId: 'revision-1', platform: 'ZHIHU',
      title: '平台标题', bodyMarkdown: null, contentHash: 'a'.repeat(64),
      model: 'writer-1', promptVersion: 'platform-v1', createdAt: '2026-10-12T00:00:00.000Z',
    })).toMatchObject({ variantId: 'variant-1' });
  });

  it('only permits explicit Medium export handoff requests', () => {
    expect(manualHandoffExportRequestSchema.parse({
      revisionId: 'revision-1', platform: 'MEDIUM', format: 'MARKDOWN', canonicalUrl: null,
    })).toMatchObject({ platform: 'MEDIUM' });
    expect(() => manualHandoffExportRequestSchema.parse({
      revisionId: 'revision-1', platform: 'CSDN', format: 'MARKDOWN', canonicalUrl: null,
    })).toThrow();
  });

  it('validates a path-free diagnostics summary', () => {
    expect(diagnosticsSummarySchema.parse({
      retentionDays: 30,
      logBytes: 128,
      artifactCount: 2,
      latestArtifactAt: '2026-10-12T00:00:00.000Z',
    })).not.toHaveProperty('path');
    expect(() => diagnosticsSummarySchema.parse({
      retentionDays: 30,
      logBytes: 128,
      artifactCount: 2,
      latestArtifactAt: null,
      logPath: 'C:/Users/name/AppData/private',
    })).toThrow();
  });
});
