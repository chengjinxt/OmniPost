// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  const api = {
    getMetadata: vi.fn(),
    listContent: vi.fn(),
    createContent: vi.fn(),
    reviseContent: vi.fn(),
    discoverImports: vi.fn(),
    previewImport: vi.fn(),
    ingestImport: vi.fn(),
    listAccounts: vi.fn(),
    saveAccount: vi.fn(),
    listPublishJobs: vi.fn(),
    createPublishPlan: vi.fn(),
    approvePublishPlan: vi.fn(),
    getAiProfile: vi.fn(),
    saveAiProfile: vi.fn(),
    generateAiVariant: vi.fn(),
    exportManualHandoff: vi.fn(),
    openManualEditor: vi.fn(),
    getDiagnostics: vi.fn(),
    exportDiagnosticLog: vi.fn(),
    openRunArtifacts: vi.fn(),
    getAutoStart: vi.fn(),
    setAutoStart: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.listContent.mockResolvedValue([]);
    api.getAutoStart.mockResolvedValue(false);
    api.discoverImports.mockResolvedValue({ cancelled: true, candidates: [] });
    api.listAccounts.mockResolvedValue([]);
    api.listPublishJobs.mockResolvedValue([]);
    api.getAiProfile.mockResolvedValue(null);
    api.exportManualHandoff.mockResolvedValue({ cancelled: false, suggestedName: 'article-medium.md' });
    api.openManualEditor.mockResolvedValue(undefined);
    api.getDiagnostics.mockResolvedValue({
      retentionDays: 30,
      logBytes: 2048,
      artifactCount: 3,
      latestArtifactAt: '2026-10-12T00:00:00.000Z',
    });
    api.exportDiagnosticLog.mockResolvedValue({
      cancelled: false,
      fileName: 'omnipost-diagnostics.jsonl',
    });
    api.openRunArtifacts.mockResolvedValue(undefined);
    Object.defineProperty(window, 'omniPost', { configurable: true, value: api });
  });

  it('presents the creator workspace and launch actions', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '内容工作台' })).toBeInTheDocument();
    expect(screen.getByText('一次创作，多端抵达')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建内容' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入内容' })).toBeInTheDocument();
    expect(screen.getByText('微信公众号')).toBeInTheDocument();
    expect(screen.getByText('抖音')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText('知乎')).toBeInTheDocument();
  });

  it('creates a new immutable content revision from the editor', async () => {
    api.createContent.mockResolvedValue({
      itemId: 'item-1',
      revisionId: 'revision-1',
      revisionNumber: 1,
      kind: 'ARTICLE',
      title: '新文章',
      bodyMarkdown: '',
      contentHash: 'a'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '新建内容' }));
    fireEvent.change(await screen.findByLabelText('内容标题'), { target: { value: '新文章' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新修订' }));

    await waitFor(() => expect(api.createContent).toHaveBeenCalledWith({
      kind: 'ARTICLE',
      title: '新文章',
      bodyMarkdown: '',
    }));
    expect(await screen.findByRole('heading', { name: '内容库' })).toBeInTheDocument();
    expect(screen.getByText('新文章')).toBeInTheDocument();
  });

  it('previews and ingests a readonly source candidate', async () => {
    api.discoverImports.mockResolvedValue({
      cancelled: false,
      candidates: [{
        id: 'candidate-1',
        importer: 'knowcraft',
        kind: 'IMAGE_POST',
        title: '知识卡片',
        relativePath: 'assets/topic',
        sourceHash: 'b'.repeat(64),
      }],
    });
    api.previewImport.mockResolvedValue({
      candidateId: 'candidate-1',
      title: '知识卡片',
      bodyMarkdown: '卡片正文',
      media: [{ originalName: '00-cover.png', kind: 'IMAGE_POST', order: 0 }],
      warnings: [],
    });
    api.ingestImport.mockResolvedValue({
      itemId: 'item-imported',
      revisionId: 'revision-imported',
      revisionNumber: 1,
      kind: 'IMAGE_POST',
      title: '知识卡片',
      bodyMarkdown: '卡片正文',
      contentHash: 'c'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '导入内容' }));
    fireEvent.click(await screen.findByRole('button', { name: 'KnowCraft' }));
    expect(await screen.findByText('知识卡片')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '预览 知识卡片' }));
    expect(await screen.findByText('00-cover.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入到内容库' }));

    await waitFor(() => expect(api.ingestImport).toHaveBeenCalledWith('candidate-1'));
    expect(await screen.findByRole('heading', { name: '内容库' })).toBeInTheDocument();
    expect(screen.getByText('知识卡片')).toBeInTheDocument();
  });

  it('stores a multi-platform account without rendering credential values', async () => {
    api.saveAccount.mockResolvedValue({
      id: 'account-1',
      platform: 'YOUTUBE',
      displayName: '主频道',
      externalAccountId: null,
      deliveryMode: 'DIRECT_API',
      enabled: true,
      credentialNames: ['accessToken'],
      capabilitiesCheckedAt: null,
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号连接' }));
    fireEvent.change(await screen.findByLabelText('账号名称'), { target: { value: '主频道' } });
    fireEvent.change(screen.getByLabelText('凭证 JSON'), {
      target: { value: '{"accessToken":"do-not-render"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '安全保存账号' }));

    await waitFor(() => expect(api.saveAccount).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'YOUTUBE',
      displayName: '主频道',
      credentials: { accessToken: 'do-not-render' },
    })));
    expect(await screen.findByText('accessToken')).toBeInTheDocument();
    expect(screen.queryByText('do-not-render')).not.toBeInTheDocument();
  });

  it('defaults browser-assisted platforms to a visible, user-confirmed delivery mode', async () => {
    api.saveAccount.mockResolvedValue({
      id: 'account-csdn', platform: 'CSDN', displayName: '技术博客', externalAccountId: null,
      deliveryMode: 'ASSISTED_BROWSER', enabled: true, credentialNames: [], capabilitiesCheckedAt: null,
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号连接' }));
    fireEvent.change(await screen.findByLabelText('平台'), { target: { value: 'CSDN' } });
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '技术博客' } });
    fireEvent.click(screen.getByRole('button', { name: '安全保存账号' }));

    await waitFor(() => expect(api.saveAccount).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'CSDN', deliveryMode: 'ASSISTED_BROWSER',
    })));
  });

  it('lets the user opt into Windows auto-start', async () => {
    api.setAutoStart.mockResolvedValue(true);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const checkbox = await screen.findByRole('checkbox', { name: '登录 Windows 后启动 OmniPost' });
    fireEvent.click(checkbox);

    await waitFor(() => expect(api.setAutoStart).toHaveBeenCalledWith(true));
    expect(checkbox).toBeChecked();
  });

  it('stores an OpenAI-compatible profile without rendering the API key', async () => {
    api.saveAiProfile.mockResolvedValue({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
      baseUrlId: 'primary',
      model: 'writer-1',
      endpoint: 'RESPONSES',
      promptVersion: 'platform-v1',
      hasApiKey: true,
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(await screen.findByLabelText('AI Base URL'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText('AI 模型'), { target: { value: 'writer-1' } });
    fireEvent.change(screen.getByLabelText('AI API Key'), { target: { value: 'never-render-this' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }));

    await waitFor(() => expect(api.saveAiProfile).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://api.example.com/v1',
      model: 'writer-1',
      apiKey: 'never-render-this',
    })));
    expect(await screen.findByText('API Key 已加密')).toBeInTheDocument();
    expect(screen.queryByText('never-render-this')).not.toBeInTheDocument();
  });

  it('separates publish-plan creation from explicit content-hash approval', async () => {
    api.getAiProfile.mockResolvedValue({
      configured: true, baseUrl: 'https://api.example.com/v1', baseUrlId: 'primary',
      model: 'writer-1', endpoint: 'RESPONSES', promptVersion: 'platform-v1',
      hasApiKey: true, updatedAt: '2026-10-12T00:00:00.000Z',
    });
    api.listContent.mockResolvedValue([{
      itemId: 'item-video', revisionId: 'revision-video', revisionNumber: 1,
      kind: 'VIDEO', title: '示例视频', bodyMarkdown: '简介', contentHash: 'd'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    }]);
    api.listAccounts.mockResolvedValue([{
      id: 'account-youtube', platform: 'YOUTUBE', displayName: '主频道',
      externalAccountId: null, deliveryMode: 'DIRECT_API', enabled: true,
      credentialNames: ['accessToken'], capabilitiesCheckedAt: null,
    }]);
    const job = (planId: string, state: 'AWAITING_APPROVAL' | 'APPROVED') => ({
      id: `job-${planId}`, planId, revisionId: 'revision-video',
      accountId: 'account-youtube', platform: 'YOUTUBE', deliveryMode: 'DIRECT_API',
      state, scheduledAt: null, attemptCount: 0, statusMessage: null,
      updatedAt: '2026-10-12T00:00:00.000Z',
    });
    const planResult = (
      planId: string,
      state: 'AWAITING_APPROVAL' | 'APPROVED',
      variantId: string,
      contentHash: string,
      title: string,
      bodyMarkdown: string,
    ) => ({
      planId,
      revisionId: 'revision-video',
      variantIds: [variantId],
      contentHash,
      targets: [{
        accountId: 'account-youtube',
        platform: 'YOUTUBE',
        deliveryMode: 'DIRECT_API',
        scheduledAt: null,
        platformFields: { title, bodyMarkdown },
      }],
      jobs: [job(planId, state)],
    });
    api.createPublishPlan
      .mockResolvedValueOnce(planResult(
        'plan-1', 'AWAITING_APPROVAL', 'variant-youtube', 'e'.repeat(64),
        'YouTube 示例标题', '平台简介',
      ))
      .mockResolvedValueOnce(planResult(
        'plan-2', 'AWAITING_APPROVAL', 'variant-youtube-2', 'f'.repeat(64),
        'YouTube 更新标题', '更新后的平台简介',
      ));
    api.approvePublishPlan.mockResolvedValue(planResult(
      'plan-2', 'APPROVED', 'variant-youtube-2', 'f'.repeat(64),
      'YouTube 更新标题', '更新后的平台简介',
    ));
    api.generateAiVariant.mockResolvedValueOnce({
      variantId: 'variant-youtube', revisionId: 'revision-video', platform: 'YOUTUBE',
      title: 'YouTube 示例标题', bodyMarkdown: '平台简介', contentHash: 'e'.repeat(64),
      model: 'writer-1', promptVersion: 'platform-v1', createdAt: '2026-10-12T00:00:00.000Z',
    }).mockResolvedValueOnce({
      variantId: 'variant-youtube-2', revisionId: 'revision-video', platform: 'YOUTUBE',
      title: 'YouTube 更新标题', bodyMarkdown: '更新后的平台简介', contentHash: 'f'.repeat(64),
      model: 'writer-1', promptVersion: 'platform-v1', createdAt: '2026-10-12T00:01:00.000Z',
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '内容库' }));
    fireEvent.click(await screen.findByRole('button', { name: '发布 示例视频' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '主频道' }));
    fireEvent.click(screen.getByRole('button', { name: '为所选平台生成 AI 版本' }));
    expect(await screen.findByText('YouTube 示例标题')).toBeInTheDocument();
    expect(api.approvePublishPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '生成发布计划' }));
    expect(await screen.findByText('AWAITING_APPROVAL')).toBeInTheDocument();
    expect(api.approvePublishPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '为所选平台生成 AI 版本' }));
    expect(await screen.findByText('YouTube 更新标题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准此内容版本' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '生成发布计划' }));
    await waitFor(() => expect(api.createPublishPlan).toHaveBeenCalledTimes(2));
    const approvalSnapshot = screen.getByRole('region', { name: '批准载荷快照' });
    expect(within(approvalSnapshot).getByRole('heading', { name: 'YouTube 更新标题' })).toBeInTheDocument();
    expect(within(approvalSnapshot).getByText('更新后的平台简介')).toBeInTheDocument();
    expect(within(approvalSnapshot).getByText('f'.repeat(64))).toBeInTheDocument();
    const approvalButton = screen.getByRole('button', { name: '批准此内容版本' });
    await waitFor(() => expect(approvalButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText('平台字段 JSON'), {
      target: { value: '{ "description": "changed" }' },
    });
    expect(approvalButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('平台字段 JSON'), { target: { value: '{}' } });
    expect(approvalButton).toBeEnabled();

    fireEvent.click(approvalButton);
    await waitFor(() => expect(api.approvePublishPlan).toHaveBeenCalledWith('plan-2'));
    expect(await screen.findByText('APPROVED')).toBeInTheDocument();
  });

  it('shows the exact persisted target snapshot before approving after restart', async () => {
    api.listContent.mockResolvedValue([{
      itemId: 'item-article', revisionId: 'revision-article', revisionNumber: 1,
      kind: 'ARTICLE', title: '本地原稿', bodyMarkdown: '本地正文', contentHash: 'a'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    }]);
    api.listAccounts.mockResolvedValue([{
      id: 'account-zhihu', platform: 'ZHIHU', displayName: '知乎账号',
      externalAccountId: null, deliveryMode: 'DIRECT_API', enabled: true,
      credentialNames: ['accessToken'], capabilitiesCheckedAt: null,
    }]);
    api.createPublishPlan.mockResolvedValue({
      planId: 'plan-restored',
      revisionId: 'revision-article',
      variantIds: ['variant-persisted-before-restart'],
      contentHash: 'c'.repeat(64),
      targets: [{
        accountId: 'account-zhihu',
        platform: 'ZHIHU',
        deliveryMode: 'DIRECT_API',
        scheduledAt: null,
        platformFields: {
          title: '重启前保存的平台标题',
          bodyMarkdown: '重启前保存的平台正文',
        },
      }],
      jobs: [{
        id: 'job-restored', planId: 'plan-restored', revisionId: 'revision-article',
        accountId: 'account-zhihu', platform: 'ZHIHU', deliveryMode: 'DIRECT_API',
        state: 'AWAITING_APPROVAL', scheduledAt: null, attemptCount: 0, statusMessage: null,
        updatedAt: '2026-10-12T00:00:00.000Z',
      }],
    });
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '内容库' }));
    fireEvent.click(await screen.findByRole('button', { name: '发布 本地原稿' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '知乎账号' }));
    fireEvent.click(screen.getByRole('button', { name: '生成发布计划' }));

    const snapshot = await screen.findByRole('region', { name: '批准载荷快照' });
    expect(within(snapshot).getByRole('heading', { name: '重启前保存的平台标题' })).toBeInTheDocument();
    expect(within(snapshot).getByText('重启前保存的平台正文')).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '批准此内容版本' }),
    ).toBeEnabled());
  });

  it('offers Medium export and editor handoff without browser filling or submission', async () => {
    api.listContent.mockResolvedValue([{
      itemId: 'item-article', revisionId: 'revision-article', revisionNumber: 1,
      kind: 'ARTICLE', title: '手动交接文章', bodyMarkdown: '正文', contentHash: 'f'.repeat(64),
      updatedAt: '2026-10-12T00:00:00.000Z',
    }]);
    api.listAccounts.mockResolvedValue([{
      id: 'account-medium', platform: 'MEDIUM', displayName: 'Medium', externalAccountId: null,
      deliveryMode: 'MANUAL_HANDOFF', enabled: true, credentialNames: [], capabilitiesCheckedAt: null,
    }]);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '内容库' }));
    fireEvent.click(await screen.findByRole('button', { name: '发布 手动交接文章' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Medium' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => expect(api.exportManualHandoff).toHaveBeenCalledWith({
      revisionId: 'revision-article', platform: 'MEDIUM', format: 'MARKDOWN', canonicalUrl: null,
    }));
    fireEvent.click(screen.getByRole('button', { name: '打开 Medium 编辑页' }));
    expect(api.openManualEditor).toHaveBeenCalledWith('MEDIUM');
  });

  it('shows redacted diagnostics and requires explicit export or folder actions', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '运行诊断' }));
    expect(await screen.findByText('3 个运行产物')).toBeInTheDocument();
    expect(screen.getByText('2 KB 日志')).toBeInTheDocument();
    expect(screen.getByText('默认保留 30 天')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出已脱敏日志' }));
    await waitFor(() => expect(api.exportDiagnosticLog).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '打开运行产物目录' }));
    await waitFor(() => expect(api.openRunArtifacts).toHaveBeenCalledOnce());
  });
});
