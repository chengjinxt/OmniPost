import {
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  CircleCheckBig,
  FilePlus2,
  Files,
  Import,
  LayoutDashboard,
  RadioTower,
  Settings,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { APP_METADATA } from '../../shared/app-metadata.js';
import { capabilityContextDtoSchema } from '../../shared/ipc.js';
import type {
  ContentDocumentDto,
  CreatePublishPlanRequest,
  AccountConnectionDto,
  AiProfileDto,
  AiVariantResultDto,
  DiagnosticsSummaryDto,
  ImportCandidateDto,
  ImportPreviewDto,
  ImporterChoice,
  PublishJobDto,
  PublishPlanResultDto,
  SaveAccountRequest,
  SaveAiProfileRequest,
} from '../../shared/ipc.js';
import { ContentEditor, type EditorValue } from './ContentEditor.js';

const platforms = [
  { name: '微信公众号', mode: '官方 API / 草稿', color: '#18a966', state: '待连接' },
  { name: '抖音', mode: '图片与视频', color: '#151b2b', state: '待连接' },
  { name: 'YouTube', mode: '视频与定时', color: '#e5484d', state: '待连接' },
  { name: '知乎', mode: '文章与想法', color: '#1677ff', state: '实验性' },
] as const;

type View = 'dashboard' | 'library' | 'calendar' | 'queue' | 'accounts' | 'diagnostics' | 'editor' | 'imports' | 'publisher' | 'settings';

const navigation: ReadonlyArray<{ label: string; icon: typeof LayoutDashboard; view: View }> = [
  { label: '工作台', icon: LayoutDashboard, view: 'dashboard' },
  { label: '内容库', icon: Files, view: 'library' },
  { label: '发布日历', icon: CalendarDays, view: 'calendar' },
  { label: '任务队列', icon: RadioTower, view: 'queue' },
  { label: '账号连接', icon: UsersRound, view: 'accounts' },
  { label: '运行诊断', icon: ChartNoAxesColumnIncreasing, view: 'diagnostics' },
] as const;

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('dashboard');
  const [documents, setDocuments] = useState<ContentDocumentDto[]>([]);
  const [editing, setEditing] = useState<ContentDocumentDto | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [importCandidates, setImportCandidates] = useState<ImportCandidateDto[]>([]);
  const [importPreview, setImportPreview] = useState<ImportPreviewDto>();
  const [importBusy, setImportBusy] = useState(false);
  const [accounts, setAccounts] = useState<AccountConnectionDto[]>([]);
  const [accountBusy, setAccountBusy] = useState(false);
  const [publishJobs, setPublishJobs] = useState<PublishJobDto[]>([]);
  const [publishing, setPublishing] = useState<ContentDocumentDto>();
  const [pendingPlan, setPendingPlan] = useState<PublishPlanResultDto>();
  const [publishBusy, setPublishBusy] = useState(false);
  const [aiProfile, setAiProfile] = useState<AiProfileDto | null>(null);
  const [aiVariants, setAiVariants] = useState<AiVariantResultDto[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSummaryDto>();
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.omniPost.listContent()
      .then((items) => {
        if (active) setDocuments(items);
      })
      .catch(() => {
        if (active) setError('内容库暂时无法读取，请在运行诊断中查看详情。');
      });
    void window.omniPost.listAccounts()
      .then((items) => {
        if (active) setAccounts(items);
      })
      .catch(() => {
        if (active) setError('账号连接暂时无法读取，请在运行诊断中查看详情。');
      });
    void window.omniPost.getAutoStart()
      .then((enabled) => {
        if (active) setAutoStart(enabled);
      })
      .catch(() => {
        if (active) setError('无法读取开机启动设置。');
      });
    void window.omniPost.listPublishJobs()
      .then((items) => {
        if (active) setPublishJobs(items);
      })
      .catch(() => {
        if (active) setError('发布队列暂时无法读取，请在运行诊断中查看详情。');
      });
    void window.omniPost.getAiProfile()
      .then((profile) => {
        if (active) setAiProfile(profile);
      })
      .catch(() => {
        if (active) setError('无法读取 AI 配置。');
      });
    void window.omniPost.getDiagnostics()
      .then((summary) => {
        if (active) setDiagnostics(summary);
      })
      .catch(() => {
        if (active) setError('无法读取运行诊断摘要。');
      });
    return () => { active = false; };
  }, []);

  const openNewContent = (): void => {
    setEditing(undefined);
    setError(undefined);
    setView('editor');
  };

  const openExistingContent = (document: ContentDocumentDto): void => {
    setEditing(document);
    setError(undefined);
    setView('editor');
  };

  const openPublisher = (document: ContentDocumentDto): void => {
    setPublishing(document);
    setPendingPlan(undefined);
    setError(undefined);
    setView('publisher');
  };

  const createPublishPlan = async (
    accountIds: string[],
    scheduledAt: string | null,
    platformFieldsByAccount: CreatePublishPlanRequest['platformFieldsByAccount'],
  ): Promise<void> => {
    if (publishing === undefined) return;
    setPublishBusy(true);
    setError(undefined);
    try {
      const result = await window.omniPost.createPublishPlan({
        revisionId: publishing.revisionId,
        accountIds,
        scheduledAt,
        ...(platformFieldsByAccount === undefined ? {} : { platformFieldsByAccount }),
      });
      setPendingPlan(result);
      setPublishJobs((current) => [
        ...result.jobs,
        ...current.filter((job) => !result.jobs.some((updated) => updated.id === job.id)),
      ]);
    } catch {
      setError('发布计划创建失败。没有任务被批准或提交，请检查账号能力和内容校验。');
    } finally {
      setPublishBusy(false);
    }
  };

  const approvePublishPlan = async (): Promise<void> => {
    if (pendingPlan === undefined) return;
    setPublishBusy(true);
    setError(undefined);
    try {
      const result = await window.omniPost.approvePublishPlan(pendingPlan.planId);
      setPendingPlan(result);
      setPublishJobs((current) => [
        ...result.jobs,
        ...current.filter((job) => !result.jobs.some((updated) => updated.id === job.id)),
      ]);
    } catch {
      setError('批准失败。内容版本可能已经变化，请重新生成发布计划。');
    } finally {
      setPublishBusy(false);
    }
  };

  const saveAiProfile = async (input: SaveAiProfileRequest): Promise<void> => {
    setAiBusy(true);
    setError(undefined);
    try {
      setAiProfile(await window.omniPost.saveAiProfile(input));
    } catch {
      setError('AI 配置保存失败。API Key 未以明文保存，请检查系统加密能力。');
      throw new Error('ai-profile-save-failed');
    } finally {
      setAiBusy(false);
    }
  };

  const generateAiVariant = async (platform: AccountConnectionDto['platform']): Promise<void> => {
    if (publishing === undefined) return;
    setAiBusy(true);
    setError(undefined);
    try {
      const generated = await window.omniPost.generateAiVariant({
        revisionId: publishing.revisionId,
        platform,
        constraints: {},
      });
      setAiVariants((current) => [
        generated,
        ...current.filter((variant) => !(
          variant.revisionId === generated.revisionId && variant.platform === generated.platform
        )),
      ]);
    } catch {
      setError('AI 平台版本生成失败。原稿未被修改，也不会自动批准发布。');
    } finally {
      setAiBusy(false);
    }
  };

  const exportManualHandoff = async (
    format: 'MARKDOWN' | 'HTML',
    canonicalUrl: string | null,
  ): Promise<void> => {
    if (publishing === undefined) return;
    setPublishBusy(true);
    setError(undefined);
    try {
      await window.omniPost.exportManualHandoff({
        revisionId: publishing.revisionId,
        platform: 'MEDIUM',
        format,
        canonicalUrl,
      });
    } catch {
      setError('手动交接导出失败。原稿没有被修改。');
    } finally {
      setPublishBusy(false);
    }
  };

  const openMediumEditor = async (): Promise<void> => {
    try {
      await window.omniPost.openManualEditor('MEDIUM');
    } catch {
      setError('无法打开 Medium 编辑页。');
    }
  };

  const saveContent = async (value: EditorValue): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = value.itemId === undefined
        ? await window.omniPost.createContent({
          kind: value.kind,
          title: value.title,
          bodyMarkdown: value.bodyMarkdown,
        })
        : await window.omniPost.reviseContent({
          itemId: value.itemId,
          kind: value.kind,
          title: value.title,
          bodyMarkdown: value.bodyMarkdown,
        });
      setDocuments((current) => [saved, ...current.filter((item) => item.itemId !== saved.itemId)]);
      setEditing(undefined);
      setView('library');
    } catch {
      setError('保存失败，原稿没有被覆盖，请重试或查看运行诊断。');
    } finally {
      setSaving(false);
    }
  };

  const discoverImports = async (importer: ImporterChoice): Promise<void> => {
    setImportBusy(true);
    setError(undefined);
    setImportPreview(undefined);
    try {
      const discovery = await window.omniPost.discoverImports(importer);
      if (!discovery.cancelled) setImportCandidates(discovery.candidates);
    } catch {
      setError('读取来源目录失败。源目录保持只读，请在运行诊断中查看详情。');
    } finally {
      setImportBusy(false);
    }
  };

  const previewImport = async (candidateId: string): Promise<void> => {
    setImportBusy(true);
    setError(undefined);
    try {
      setImportPreview(await window.omniPost.previewImport(candidateId));
    } catch {
      setError('预览失败；来源可能已变化，请重新选择目录。');
    } finally {
      setImportBusy(false);
    }
  };

  const ingestImport = async (): Promise<void> => {
    if (importPreview === undefined) return;
    setImportBusy(true);
    setError(undefined);
    try {
      const document = await window.omniPost.ingestImport(importPreview.candidateId);
      setDocuments((current) => [document, ...current.filter((item) => item.itemId !== document.itemId)]);
      setImportCandidates([]);
      setImportPreview(undefined);
      setView('library');
    } catch {
      setError('导入失败；没有修改来源文件，也没有覆盖现有原稿。');
    } finally {
      setImportBusy(false);
    }
  };

  const saveAccount = async (input: SaveAccountRequest): Promise<void> => {
    setAccountBusy(true);
    setError(undefined);
    try {
      const saved = await window.omniPost.saveAccount(input);
      setAccounts((current) => [saved, ...current.filter((account) => account.id !== saved.id)]);
    } catch {
      setError('账号保存失败。凭证不会以明文写入磁盘，请检查系统加密能力和输入格式。');
      throw new Error('account-save-failed');
    } finally {
      setAccountBusy(false);
    }
  };

  const updateAutoStart = async (enabled: boolean): Promise<void> => {
    setSettingsBusy(true);
    setError(undefined);
    try {
      setAutoStart(await window.omniPost.setAutoStart(enabled));
    } catch {
      setError('更新开机启动设置失败。');
    } finally {
      setSettingsBusy(false);
    }
  };

  const exportDiagnosticLog = async (): Promise<void> => {
    setDiagnosticsBusy(true);
    setError(undefined);
    try {
      await window.omniPost.exportDiagnosticLog();
      setDiagnostics(await window.omniPost.getDiagnostics());
    } catch {
      setError('导出诊断日志失败。');
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const openRunArtifacts = async (): Promise<void> => {
    setDiagnosticsBusy(true);
    setError(undefined);
    try {
      await window.omniPost.openRunArtifacts();
    } catch {
      setError('无法打开运行产物目录。');
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="./OmniPost.jpg" alt="OmniPost" />
          <div>
            <strong>{APP_METADATA.name}</strong>
            <span>{APP_METADATA.tagline}</span>
          </div>
        </div>

        <nav aria-label="主导航">
          {navigation.map(({ label, icon: Icon, view: destination }) => (
            <button
              className={view === destination ? 'nav-item active' : 'nav-item'}
              key={label}
              type="button"
              onClick={() => setView(destination)}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <button className={view === 'settings' ? 'nav-item settings active' : 'nav-item settings'} type="button" onClick={() => setView('settings')}>
          <Settings size={19} strokeWidth={1.8} />
          <span>设置</span>
        </button>
      </aside>

      <main>
        {error === undefined ? null : <div className="error-banner" role="alert">{error}</div>}
        {view === 'editor' ? (
          <ContentEditor
            {...(editing === undefined ? {} : { initialValue: {
              itemId: editing.itemId,
              kind: editing.kind,
              title: editing.title,
              bodyMarkdown: editing.bodyMarkdown,
            } })}
            saving={saving}
            onCancel={() => setView(editing === undefined ? 'dashboard' : 'library')}
            onSave={saveContent}
          />
        ) : view === 'library' ? (
          <ContentLibrary documents={documents} onCreate={openNewContent} onEdit={openExistingContent} onPublish={openPublisher} />
        ) : view === 'imports' ? (
          <ImportWorkspace
            busy={importBusy}
            candidates={importCandidates}
            preview={importPreview}
            onBack={() => setView('dashboard')}
            onDiscover={discoverImports}
            onIngest={ingestImport}
            onPreview={previewImport}
          />
        ) : view === 'accounts' ? (
          <AccountWorkspace accounts={accounts} busy={accountBusy} onSave={saveAccount} />
        ) : view === 'publisher' && publishing !== undefined ? (
          <PublicationWorkspace
            accounts={accounts}
            aiConfigured={aiProfile !== null}
            aiVariants={aiVariants.filter((variant) => variant.revisionId === publishing.revisionId)}
            busy={publishBusy || aiBusy}
            document={publishing}
            jobs={publishJobs.filter((job) => job.revisionId === publishing.revisionId)}
            plan={pendingPlan}
            onApprove={approvePublishPlan}
            onBack={() => setView('library')}
            onCreate={createPublishPlan}
            onGenerateAi={generateAiVariant}
            onExportManual={exportManualHandoff}
            onOpenMedium={openMediumEditor}
          />
        ) : view === 'queue' ? (
          <JobWorkspace jobs={publishJobs} mode="queue" />
        ) : view === 'calendar' ? (
          <JobWorkspace jobs={publishJobs.filter((job) => job.scheduledAt !== null)} mode="calendar" />
        ) : view === 'settings' ? (
          <SettingsWorkspace
            aiBusy={aiBusy}
            aiProfile={aiProfile}
            autoStart={autoStart}
            busy={settingsBusy}
            onAiSave={saveAiProfile}
            onAutoStart={updateAutoStart}
          />
        ) : view === 'diagnostics' ? (
          <DiagnosticsWorkspace
            busy={diagnosticsBusy}
            summary={diagnostics}
            onExport={exportDiagnosticLog}
            onOpenArtifacts={openRunArtifacts}
          />
        ) : view === 'dashboard' ? (
          <Dashboard onCreate={openNewContent} onImport={() => setView('imports')} />
        ) : (
          <Placeholder view={view} />
        )}
      </main>
    </div>
  );
}

function Dashboard({ onCreate, onImport }: { onCreate(): void; onImport(): void }): React.JSX.Element {
  return (
    <>
        <header className="page-header">
          <div>
            <p className="eyebrow">OMNIPOST CREATOR DESK</p>
            <h1>内容工作台</h1>
            <p>把一份内容整理成适合不同平台的版本，并在发布前逐项确认。</p>
          </div>
          <div className="header-actions">
            <button className="secondary-action" type="button" onClick={onImport}>
              <Import size={18} />
              导入内容
            </button>
            <button className="primary-action" type="button" onClick={onCreate}>
              <FilePlus2 size={18} />
              新建内容
            </button>
          </div>
        </header>

        <section className="hero-card">
          <div className="hero-copy">
            <span className="pill"><Sparkles size={15} /> 新的创作流程</span>
            <h2>从一篇原稿，抵达每一个内容阵地。</h2>
            <p>导入 Markdown、图集或视频，OmniPost 会保留原稿并为每个平台建立独立版本。只有你确认过的版本才会进入发布队列。</p>
            <div className="flow">
              <span>导入</span><i />
              <span>适配</span><i />
              <span>预览</span><i />
              <span>发布</span>
            </div>
          </div>
          <div className="hero-stat">
            <CircleCheckBig size={32} />
            <strong>0</strong>
            <span>待审核内容</span>
          </div>
        </section>

        <section className="section-block">
          <div className="section-title">
            <div>
              <p className="eyebrow">FIRST CONNECTIONS</p>
              <h2>首发平台</h2>
            </div>
            <button className="text-action" type="button">管理全部账号 →</button>
          </div>
          <div className="platform-grid">
            {platforms.map((platform) => (
              <article className="platform-card" key={platform.name}>
                <span className="platform-mark" style={{ backgroundColor: platform.color }} />
                <div>
                  <h3>{platform.name}</h3>
                  <p>{platform.mode}</p>
                </div>
                <span className="status-chip">{platform.state}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="empty-state">
          <div className="empty-icon"><Files size={28} /></div>
          <h2>从第一份内容开始</h2>
          <p>可导入通用 Markdown，也能只读兼容 tgexporter 和 KnowCraft 的内容目录。</p>
          <button className="secondary-action" type="button" onClick={onImport}><Import size={18} />选择来源目录</button>
        </section>
    </>
  );
}

function ContentLibrary({
  documents,
  onCreate,
  onEdit,
  onPublish,
}: {
  documents: ContentDocumentDto[];
  onCreate(): void;
  onEdit(document: ContentDocumentDto): void;
  onPublish(document: ContentDocumentDto): void;
}): React.JSX.Element {
  return (
    <section className="content-library">
      <header className="page-header">
        <div>
          <p className="eyebrow">CONTENT LIBRARY</p>
          <h1>内容库</h1>
          <p>原稿始终保留；每次保存都会创建一份新的不可变修订。</p>
        </div>
        <button className="primary-action" type="button" onClick={onCreate}><FilePlus2 size={18} />新建内容</button>
      </header>
      {documents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Files size={28} /></div>
          <h2>还没有内容</h2>
          <p>新建一份原稿，或从 Markdown、tgexporter、KnowCraft 导入。</p>
        </div>
      ) : (
        <div className="document-list" aria-label="内容列表">
          {documents.map((document) => (
            <article className="document-card" key={document.itemId}>
              <span className="document-kind">{kindLabel(document.kind)}</span>
              <button className="document-copy" type="button" onClick={() => onEdit(document)}>
                <strong>{document.title}</strong>
                <small>修订 #{document.revisionNumber} · {new Date(document.updatedAt).toLocaleString('zh-CN')}</small>
              </button>
              <span className="document-actions">
                <button className="text-action" type="button" onClick={() => onEdit(document)}>编辑新修订</button>
                <button aria-label={`发布 ${document.title}`} className="secondary-action" type="button" onClick={() => onPublish(document)}>准备发布</button>
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Placeholder({ view }: { view: Exclude<View, 'dashboard' | 'library' | 'editor' | 'imports' | 'accounts' | 'queue' | 'calendar' | 'settings' | 'diagnostics'> }): React.JSX.Element {
  const labels: Record<typeof view, { title: string; description: string }> = {
    publisher: { title: '准备发布', description: '请从内容库选择需要发布的内容版本。' },
  };
  const current = labels[view];
  return (
    <section className="placeholder-page">
      <p className="eyebrow">OMNIPOST</p>
      <h1>{current.title}</h1>
      <p>{current.description}</p>
      <span className="status-chip">基础模块已就绪</span>
    </section>
  );
}

function DiagnosticsWorkspace({
  busy,
  summary,
  onExport,
  onOpenArtifacts,
}: {
  busy: boolean;
  summary: DiagnosticsSummaryDto | undefined;
  onExport(): Promise<void>;
  onOpenArtifacts(): Promise<void>;
}): React.JSX.Element {
  return (
    <section className="diagnostics-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">LOCAL DIAGNOSTICS</p>
          <h1>运行诊断</h1>
          <p>日志在主进程写入时已脱敏；截图和 Playwright Trace 只保存在本机。</p>
        </div>
      </header>
      <div className="diagnostics-grid">
        <article>
          <span>日志</span>
          <strong>{summary === undefined ? '读取中…' : `${formatBytes(summary.logBytes)} 日志`}</strong>
          <small>导出前不会离开本机</small>
        </article>
        <article>
          <span>运行产物</span>
          <strong>{summary === undefined ? '读取中…' : `${summary.artifactCount} 个运行产物`}</strong>
          <small>{summary?.latestArtifactAt === null || summary === undefined
            ? '暂无截图或 Trace'
            : `最近更新 ${new Date(summary.latestArtifactAt).toLocaleString('zh-CN')}`}</small>
        </article>
        <article>
          <span>保留策略</span>
          <strong>{summary === undefined ? '读取中…' : `默认保留 ${summary.retentionDays} 天`}</strong>
          <small>启动时清理过期运行目录</small>
        </article>
      </div>
      <div className="diagnostics-actions">
        <button className="primary-action" disabled={busy} type="button" onClick={() => void onExport()}>导出已脱敏日志</button>
        <button className="secondary-action" disabled={busy} type="button" onClick={() => void onOpenArtifacts()}>打开运行产物目录</button>
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSnapshotField(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return JSON.stringify(value);
}

function PublicationWorkspace({
  accounts,
  aiConfigured,
  aiVariants,
  busy,
  document,
  jobs,
  plan,
  onApprove,
  onBack,
  onCreate,
  onExportManual,
  onGenerateAi,
  onOpenMedium,
}: {
  accounts: AccountConnectionDto[];
  aiConfigured: boolean;
  aiVariants: AiVariantResultDto[];
  busy: boolean;
  document: ContentDocumentDto;
  jobs: PublishJobDto[];
  plan: PublishPlanResultDto | undefined;
  onApprove(): Promise<void>;
  onBack(): void;
  onCreate(
    accountIds: string[],
    scheduledAt: string | null,
    platformFieldsByAccount: CreatePublishPlanRequest['platformFieldsByAccount'],
  ): Promise<void>;
  onExportManual(format: 'MARKDOWN' | 'HTML', canonicalUrl: string | null): Promise<void>;
  onGenerateAi(platform: AccountConnectionDto['platform']): Promise<void>;
  onOpenMedium(): Promise<void>;
}): React.JSX.Element {
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [schedule, setSchedule] = useState('');
  const [canonicalUrl, setCanonicalUrl] = useState('');
  const [platformFieldsJson, setPlatformFieldsJson] = useState('{}');
  const [platformFieldsError, setPlatformFieldsError] = useState<string>();
  const planId = plan?.planId;
  const planJobs = planId === undefined ? [] : jobs.filter((job) => job.planId === planId);
  const documentVariants = useMemo(
    () => aiVariants.filter((variant) => variant.revisionId === document.revisionId),
    [aiVariants, document.revisionId],
  );
  const currentPlanInputs = useMemo(() => JSON.stringify({
    accountIds: [...selectedAccounts].sort(),
    schedule,
    platformFieldsJson,
    variants: documentVariants
      .map((variant) => ({
        platform: variant.platform,
        variantId: variant.variantId,
        contentHash: variant.contentHash,
      }))
      .sort((left, right) => left.platform.localeCompare(right.platform)),
  }), [documentVariants, platformFieldsJson, schedule, selectedAccounts]);
  const capturedPlanId = useRef<string | undefined>(undefined);
  const [plannedInputs, setPlannedInputs] = useState<string>();
  useEffect(() => {
    if (planId === undefined) {
      capturedPlanId.current = undefined;
      setPlannedInputs(undefined);
      return;
    }
    if (capturedPlanId.current !== planId) {
      capturedPlanId.current = planId;
      setPlannedInputs(currentPlanInputs);
    }
  }, [currentPlanInputs, planId]);
  const planInputsAreCurrent = plannedInputs !== undefined && plannedInputs === currentPlanInputs;
  const canApprove = planInputsAreCurrent &&
    planJobs.some((job) => job.state === 'AWAITING_APPROVAL');
  const selectedAccount = accounts.find((account) => selectedAccounts.includes(account.id));
  const selectedPlatform = selectedAccount?.platform;
  const isMediumHandoff = selectedAccount?.platform === 'MEDIUM'
    && selectedAccount.deliveryMode === 'MANUAL_HANDOFF';

  const toggleAccount = (accountId: string, checked: boolean): void => {
    setSelectedAccounts((current) => checked
      ? [...current, accountId]
      : current.filter((id) => id !== accountId));
  };

  return (
    <section className="publication-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">REVIEW BEFORE PUBLISH</p>
          <h1>准备发布</h1>
          <p>计划创建与内容批准彼此独立；任何新修订都会使既有批准失效。</p>
        </div>
        <button className="secondary-action" type="button" onClick={onBack}>返回内容库</button>
      </header>
      <div className="publication-layout">
        <article className="publication-source">
          <span className="document-kind">{kindLabel(document.kind)}</span>
          <h2>{document.title}</h2>
          <p>不可变修订 #{document.revisionNumber}</p>
          <code>{document.contentHash}</code>
          <pre>{document.bodyMarkdown || '（无文字正文）'}</pre>
        </article>
        <form className="publication-form" onSubmit={(event) => {
          event.preventDefault();
          setPlatformFieldsError(undefined);
          try {
            const fields = JSON.parse(platformFieldsJson) as unknown;
            if (fields === null || Array.isArray(fields) || typeof fields !== 'object') throw new Error();
            const scheduledAt = schedule.length === 0 ? null : new Date(schedule).toISOString();
            const platformFieldsByAccount = Object.fromEntries(
              selectedAccounts.map((accountId) => [accountId, fields]),
            ) as CreatePublishPlanRequest['platformFieldsByAccount'];
            void onCreate(selectedAccounts, scheduledAt, platformFieldsByAccount);
          } catch {
            setPlatformFieldsError('请输入有效的平台字段 JSON 对象。');
          }
        }}>
          <h2>目标账号</h2>
          {accounts.filter((account) => account.enabled).length === 0 ? <p>请先在“账号连接”中配置可用账号。</p> : accounts.filter((account) => account.enabled).map((account) => (
            <label className="account-choice" key={account.id}>
              <input
                aria-label={account.displayName}
                checked={selectedAccounts.includes(account.id)}
                disabled={busy}
                type="checkbox"
                onChange={(event) => toggleAccount(account.id, event.target.checked)}
              />
              <span><strong>{account.displayName}</strong><small>{account.platform} · {account.deliveryMode}</small></span>
            </label>
          ))}
          <label className="schedule-field">
            <span>预约时间（可选，本机时区）</span>
            <input aria-label="预约时间" disabled={busy} type="datetime-local" value={schedule} onChange={(event) => setSchedule(event.target.value)} />
          </label>
          <label className="platform-fields-field">
            <span>平台字段 JSON（高级，应用到本次所选账号）</span>
            <textarea
              aria-label="平台字段 JSON"
              disabled={busy}
              rows={5}
              spellCheck={false}
              value={platformFieldsJson}
              onChange={(event) => setPlatformFieldsJson(event.target.value)}
            />
          </label>
          {platformFieldsError === undefined ? null : <p className="form-error" role="alert">{platformFieldsError}</p>}
          <button
            className="secondary-action ai-generate-action"
            disabled={busy || !aiConfigured || selectedPlatform === undefined}
            type="button"
            onClick={() => { if (selectedPlatform !== undefined) void onGenerateAi(selectedPlatform); }}
          >为所选平台生成 AI 版本</button>
          {!aiConfigured ? <p className="field-help">请先在设置中配置 OpenAI-compatible 服务。</p> : null}
          {isMediumHandoff ? (
            <section className="manual-handoff" aria-label="Medium 手动交接">
              <h3>Medium 手动交接</h3>
              <p>仅导出内容并打开公开编辑页，不会自动填表或提交。</p>
              <label>
                <span>Canonical URL（可选）</span>
                <input
                  aria-label="Canonical URL"
                  disabled={busy}
                  placeholder="https://example.com/original-article"
                  type="url"
                  value={canonicalUrl}
                  onChange={(event) => setCanonicalUrl(event.target.value)}
                />
              </label>
              <div className="manual-handoff-actions">
                <button
                  className="secondary-action"
                  disabled={busy}
                  type="button"
                  onClick={() => void onExportManual(
                    'MARKDOWN',
                    canonicalUrl.trim().length === 0 ? null : canonicalUrl.trim(),
                  )}
                >导出 Markdown</button>
                <button
                  className="secondary-action"
                  disabled={busy}
                  type="button"
                  onClick={() => void onExportManual(
                    'HTML',
                    canonicalUrl.trim().length === 0 ? null : canonicalUrl.trim(),
                  )}
                >导出 HTML</button>
                <button
                  className="secondary-action"
                  disabled={busy}
                  type="button"
                  onClick={() => void onOpenMedium()}
                >打开 Medium 编辑页</button>
              </div>
            </section>
          ) : null}
          <button className="primary-action" disabled={busy || selectedAccounts.length === 0} type="submit">生成发布计划</button>
        </form>
      </div>
      {documentVariants.length === 0 ? null : (
        <section className="variant-list" aria-label="AI 平台版本">
          {documentVariants.map((variant) => (
            <article key={variant.variantId}>
              <span className="status-chip">{variant.platform}</span>
              <h2>{variant.title ?? document.title}</h2>
              <p>{variant.bodyMarkdown ?? document.bodyMarkdown}</p>
              <small>{variant.model} · {variant.promptVersion}</small>
            </article>
          ))}
        </section>
      )}
      {planJobs.length === 0 ? null : (
        <section className="approval-card" aria-label="发布计划审批">
          <div>
            <p className="eyebrow">EXPLICIT APPROVAL</p>
            <h2>逐项确认后批准此内容版本</h2>
            <p>批准只绑定当前内容哈希，不会自动批准之后的编辑。</p>
          </div>
          {plan === undefined ? null : (
            <section className="approval-snapshot" aria-label="批准载荷快照">
              <h3>将要批准的不可变载荷</h3>
              <p>内容哈希</p>
              <code>{plan.contentHash}</code>
              {plan.targets.map((target) => (
                <article key={`${target.accountId}-${target.platform}`}>
                  <span className="status-chip">{target.platform} · {target.deliveryMode}</span>
                  <p>账号：{target.accountId}</p>
                  <h4>{formatSnapshotField(target.platformFields.title, '（无标题）')}</h4>
                  <pre>{formatSnapshotField(
                    target.platformFields.bodyMarkdown ?? target.platformFields.bodyHtml,
                    '（无文字正文）',
                  )}</pre>
                  <details>
                    <summary>查看全部平台字段</summary>
                    <pre>{JSON.stringify(target.platformFields, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </section>
          )}
          <div className="plan-jobs">{planJobs.map((job) => <JobCard job={job} key={job.id} />)}</div>
          {planInputsAreCurrent ? null : (
            <p className="form-error" role="status">平台版本或计划字段已经变化，请重新生成发布计划后再批准。</p>
          )}
          <button className="primary-action" disabled={busy || !canApprove} type="button" onClick={() => void onApprove()}>批准此内容版本</button>
        </section>
      )}
    </section>
  );
}

function JobWorkspace({ jobs, mode }: { jobs: PublishJobDto[]; mode: 'queue' | 'calendar' }): React.JSX.Element {
  const title = mode === 'queue' ? '任务队列' : '发布日历';
  return (
    <section className="job-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">{mode === 'queue' ? 'PUBLISH QUEUE' : 'SCHEDULED PUBLICATIONS'}</p>
          <h1>{title}</h1>
          <p>{mode === 'queue' ? '查看每个账号的提交、处理和人工接管状态。' : '仅显示设置了预约时间的发布任务。'}</p>
        </div>
      </header>
      {jobs.length === 0 ? <div className="empty-state"><h2>暂无任务</h2><p>从内容库选择一份原稿并生成发布计划。</p></div> : (
        <div className="job-list">{jobs.map((job) => <JobCard job={job} key={job.id} />)}</div>
      )}
    </section>
  );
}

function JobCard({ job }: { job: PublishJobDto }): React.JSX.Element {
  return (
    <article className="job-card">
      <div><strong>{job.platform}</strong><small>{job.deliveryMode} · 尝试 {job.attemptCount} 次</small></div>
      <span className={`status-chip state-${job.state.toLowerCase()}`}>{job.state}</span>
      <p>{job.scheduledAt === null ? '批准后立即进入调度' : `预约 ${new Date(job.scheduledAt).toLocaleString('zh-CN')}`}</p>
      {job.statusMessage === null ? null : <p>{job.statusMessage}</p>}
    </article>
  );
}

function SettingsWorkspace({
  aiBusy,
  aiProfile,
  autoStart,
  busy,
  onAiSave,
  onAutoStart,
}: {
  aiBusy: boolean;
  aiProfile: AiProfileDto | null;
  autoStart: boolean;
  busy: boolean;
  onAiSave(input: SaveAiProfileRequest): Promise<void>;
  onAutoStart(enabled: boolean): Promise<void>;
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(aiProfile?.baseUrl ?? 'https://api.openai.com/v1');
  const [baseUrlId, setBaseUrlId] = useState(aiProfile?.baseUrlId ?? 'openai-compatible');
  const [model, setModel] = useState(aiProfile?.model ?? '');
  const [endpoint, setEndpoint] = useState<SaveAiProfileRequest['endpoint']>(aiProfile?.endpoint ?? 'RESPONSES');
  const [promptVersion, setPromptVersion] = useState(aiProfile?.promptVersion ?? 'platform-v1');
  const [apiKey, setApiKey] = useState('');

  const saveAi = async (): Promise<void> => {
    await onAiSave({
      baseUrl,
      baseUrlId,
      model,
      endpoint,
      promptVersion,
      apiKey: apiKey.trim().length === 0 ? null : apiKey,
    });
    setApiKey('');
  };

  return (
    <section className="settings-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">LOCAL SETTINGS</p>
          <h1>设置</h1>
          <p>OmniPost 默认使用中文和 Asia/Shanghai 时区，所有内容保存在本机。</p>
        </div>
      </header>
      <div className="settings-card">
        <div>
          <h2>后台运行</h2>
          <p>启用后，登录 Windows 时启动 OmniPost；关闭主窗口仍会保留托盘和计划任务。</p>
        </div>
        <label className="switch-row">
          <input
            aria-label="登录 Windows 后启动 OmniPost"
            checked={autoStart}
            disabled={busy}
            type="checkbox"
            onChange={(event) => void onAutoStart(event.target.checked)}
          />
          <span>{autoStart ? '已启用' : '未启用'}</span>
        </label>
      </div>
      <form className="ai-settings-card" onSubmit={(event) => { event.preventDefault(); void saveAi(); }}>
        <div className="ai-settings-copy">
          <p className="eyebrow">OPTIONAL AI ADAPTER</p>
          <h2>OpenAI-compatible 平台版本生成</h2>
          <p>只生成独立的平台变体，不修改原稿，也不会自动批准。API Key 使用 Windows DPAPI 加密。</p>
          {aiProfile?.hasApiKey === true ? <span className="status-chip">API Key 已加密</span> : null}
        </div>
        <div className="ai-settings-fields">
          <label><span>Base URL</span><input aria-label="AI Base URL" required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label><span>配置标识</span><input aria-label="AI 配置标识" required value={baseUrlId} onChange={(event) => setBaseUrlId(event.target.value)} /></label>
          <label><span>模型</span><input aria-label="AI 模型" required value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label><span>接口格式</span><select aria-label="AI 接口格式" value={endpoint} onChange={(event) => setEndpoint(event.target.value as SaveAiProfileRequest['endpoint'])}><option value="RESPONSES">Responses</option><option value="CHAT_COMPLETIONS">Chat Completions</option></select></label>
          <label><span>提示词版本</span><input aria-label="AI 提示词版本" required value={promptVersion} onChange={(event) => setPromptVersion(event.target.value)} /></label>
          <label><span>API Key（留空表示无 Key）</span><input aria-label="AI API Key" autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
          <button className="primary-action" disabled={aiBusy || model.trim().length === 0} type="submit">保存 AI 配置</button>
        </div>
      </form>
    </section>
  );
}

const accountPlatforms: ReadonlyArray<{ value: SaveAccountRequest['platform']; label: string }> = [
  { value: 'YOUTUBE', label: 'YouTube' },
  { value: 'WECHAT_OFFICIAL_ACCOUNT', label: '微信公众号' },
  { value: 'DOUYIN', label: '抖音' },
  { value: 'ZHIHU', label: '知乎（实验）' },
  { value: 'KUAISHOU', label: '快手' },
  { value: 'TOUTIAO', label: '今日头条' },
  { value: 'WECHAT_CHANNELS', label: '视频号' },
  { value: 'XIAOHONGSHU', label: '小红书' },
  { value: 'BAIJIAHAO', label: '百家号（实验）' },
  { value: 'CSDN', label: 'CSDN' },
  { value: 'JUEJIN', label: '掘金' },
  { value: 'SUBSTACK', label: 'Substack' },
  { value: 'MEDIUM', label: 'Medium（仅交接）' },
];

function defaultDeliveryMode(platform: SaveAccountRequest['platform']): SaveAccountRequest['deliveryMode'] {
  if (platform === 'MEDIUM' || platform === 'XIAOHONGSHU') return 'MANUAL_HANDOFF';
  if (['WECHAT_CHANNELS', 'TOUTIAO', 'BAIJIAHAO', 'CSDN', 'JUEJIN', 'SUBSTACK'].includes(platform)) {
    return 'ASSISTED_BROWSER';
  }
  return 'DIRECT_API';
}

function AccountWorkspace({
  accounts,
  busy,
  onSave,
}: {
  accounts: AccountConnectionDto[];
  busy: boolean;
  onSave(input: SaveAccountRequest): Promise<void>;
}): React.JSX.Element {
  const [platform, setPlatform] = useState<SaveAccountRequest['platform']>('YOUTUBE');
  const [deliveryMode, setDeliveryMode] = useState<SaveAccountRequest['deliveryMode']>('DIRECT_API');
  const [displayName, setDisplayName] = useState('');
  const [credentialsJson, setCredentialsJson] = useState('{}');
  const [capabilityJson, setCapabilityJson] = useState(JSON.stringify({
    qualifications: [],
    scopes: [],
    probes: {
      directApi: 'UNKNOWN',
      remoteDraft: 'UNKNOWN',
      assistedBrowser: 'AVAILABLE',
    },
  }, null, 2));
  const [formError, setFormError] = useState<string>();

  const submit = async (): Promise<void> => {
    setFormError(undefined);
    try {
      const parsed: unknown = JSON.parse(credentialsJson);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
      const credentials = Object.fromEntries(Object.entries(parsed).map(([name, value]) => {
        if (typeof value !== 'string' || value.length === 0) throw new Error();
        return [name, value];
      }));
      const capabilityContext = capabilityContextDtoSchema.parse(JSON.parse(capabilityJson));
      await onSave({
        platform,
        displayName,
        externalAccountId: null,
        deliveryMode,
        credentials,
        capabilityContext,
      });
      setDisplayName('');
      setCredentialsJson('{}');
    } catch {
      setFormError('请输入有效的凭证与能力探测 JSON；凭证值必须是非空字符串。');
    }
  };

  return (
    <section className="account-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">ACCOUNT VAULT</p>
          <h1>账号连接</h1>
          <p>凭证仅经 Windows DPAPI 加密保存；列表只显示凭证名称。</p>
        </div>
      </header>
      <div className="account-layout">
        <form className="account-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <h2>配置账号</h2>
          <label><span>平台</span><select aria-label="平台" value={platform} onChange={(event) => { const selected = event.target.value as SaveAccountRequest['platform']; setPlatform(selected); setDeliveryMode(defaultDeliveryMode(selected)); }}>{accountPlatforms.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label><span>接入模式</span><select aria-label="接入模式" value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as SaveAccountRequest['deliveryMode'])}><option value="DIRECT_API">官方 API</option><option value="REMOTE_DRAFT">远端草稿</option><option value="ASSISTED_BROWSER">可见浏览器辅助</option><option value="MANUAL_HANDOFF">手动交接</option></select></label>
          <label><span>账号名称</span><input aria-label="账号名称" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label><span>凭证 JSON</span><textarea aria-label="凭证 JSON" rows={7} spellCheck={false} value={credentialsJson} onChange={(event) => setCredentialsJson(event.target.value)} /></label>
          <p className="field-help">示例：{platform === 'YOUTUBE' ? '{ "accessToken": "…", "refreshToken": "…" }' : '{ "accessToken": "…" }'}</p>
          <label><span>能力探测结果 JSON</span><textarea aria-label="能力探测结果 JSON" rows={8} spellCheck={false} value={capabilityJson} onChange={(event) => setCapabilityJson(event.target.value)} /></label>
          <p className="field-help">未确认的 API 能力保持 UNKNOWN；本地可见 Edge 标记为 AVAILABLE。发布时会按内容类型安全降级。</p>
          {formError === undefined ? null : <p className="form-error" role="alert">{formError}</p>}
          <button className="primary-action" disabled={busy || displayName.trim().length === 0} type="submit">安全保存账号</button>
        </form>
        <div className="account-list">
          <h2>已配置账号</h2>
          {accounts.length === 0 ? <p>尚未配置账号。</p> : accounts.map((account) => (
            <article className="account-card" key={account.id}>
              <div><strong>{account.displayName}</strong><small>{accountPlatforms.find((item) => item.value === account.platform)?.label ?? account.platform}</small></div>
              <span className="status-chip">{account.deliveryMode}</span>
              <p>已加密：{account.credentialNames.length === 0 ? '无凭证' : account.credentialNames.map((name, index) => <code key={name}>{index === 0 ? '' : '、'}{name}</code>)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ImportWorkspace({
  busy,
  candidates,
  preview,
  onBack,
  onDiscover,
  onIngest,
  onPreview,
}: {
  busy: boolean;
  candidates: ImportCandidateDto[];
  preview: ImportPreviewDto | undefined;
  onBack(): void;
  onDiscover(importer: ImporterChoice): Promise<void>;
  onIngest(): Promise<void>;
  onPreview(candidateId: string): Promise<void>;
}): React.JSX.Element {
  return (
    <section className="import-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">READONLY SOURCE</p>
          <h1>导入内容</h1>
          <p>只读取来源并复制到 OmniPost；不会修改 tgexporter 或 KnowCraft。</p>
        </div>
        <button className="secondary-action" type="button" onClick={onBack}>返回工作台</button>
      </header>
      <div className="importer-grid" aria-label="来源类型">
        <button aria-label="通用 Markdown" disabled={busy} type="button" onClick={() => void onDiscover('markdown')}><strong>通用 Markdown</strong><span>.md / .markdown / .mk</span></button>
        <button aria-label="tgexporter" disabled={busy} type="button" onClick={() => void onDiscover('tgexporter')}><strong>tgexporter</strong><span>兼容批次与两种 frontmatter</span></button>
        <button aria-label="KnowCraft" disabled={busy} type="button" onClick={() => void onDiscover('knowcraft')}><strong>KnowCraft</strong><span>扫描 assets 一级主题目录</span></button>
      </div>
      <div className="import-layout">
        <div className="candidate-list" aria-label="候选内容">
          {candidates.length === 0 ? <p>请选择来源目录以发现可导入内容。</p> : candidates.map((candidate) => (
            <article className="candidate-card" key={candidate.id}>
              <div><strong>{candidate.title}</strong><small>{candidate.relativePath}</small></div>
              <button
                aria-label={`预览 ${candidate.title}`}
                className="text-action"
                disabled={busy}
                type="button"
                onClick={() => void onPreview(candidate.id)}
              >预览 →</button>
            </article>
          ))}
        </div>
        <aside className="import-preview" aria-label="导入预览">
          {preview === undefined ? <p>选择候选内容后，在这里检查正文、媒体和警告。</p> : (
            <>
              <span className="pill">导入预览</span>
              <h2>{preview.title}</h2>
              <pre>{preview.bodyMarkdown || '（仅媒体内容）'}</pre>
              {preview.media.map((media) => <span className="media-chip" key={`${media.order}-${media.originalName}`}>{media.originalName}</span>)}
              {preview.warnings.map((warning) => <p className="preview-warning" key={warning}>{warning}</p>)}
              <button className="primary-action" disabled={busy} type="button" onClick={() => void onIngest()}>导入到内容库</button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function kindLabel(kind: ContentDocumentDto['kind']): string {
  return { ARTICLE: '文章', IMAGE_POST: '图文', VIDEO: '视频' }[kind];
}
