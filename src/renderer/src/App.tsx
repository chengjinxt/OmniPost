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

import { APP_METADATA } from '../../shared/app-metadata.js';

const platforms = [
  { name: '微信公众号', mode: '官方 API / 草稿', color: '#18a966', state: '待连接' },
  { name: '抖音', mode: '图片与视频', color: '#151b2b', state: '待连接' },
  { name: 'YouTube', mode: '视频与定时', color: '#e5484d', state: '待连接' },
  { name: '知乎', mode: '文章与想法', color: '#1677ff', state: '实验性' },
] as const;

const navigation = [
  { label: '工作台', icon: LayoutDashboard, active: true },
  { label: '内容库', icon: Files, active: false },
  { label: '发布日历', icon: CalendarDays, active: false },
  { label: '任务队列', icon: RadioTower, active: false },
  { label: '账号连接', icon: UsersRound, active: false },
  { label: '运行诊断', icon: ChartNoAxesColumnIncreasing, active: false },
] as const;

export function App(): React.JSX.Element {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/OmniPost.jpg" alt="OmniPost" />
          <div>
            <strong>{APP_METADATA.name}</strong>
            <span>{APP_METADATA.tagline}</span>
          </div>
        </div>

        <nav aria-label="主导航">
          {navigation.map(({ label, icon: Icon, active }) => (
            <button className={active ? 'nav-item active' : 'nav-item'} key={label} type="button">
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <button className="nav-item settings" type="button">
          <Settings size={19} strokeWidth={1.8} />
          <span>设置</span>
        </button>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">OMNIPOST CREATOR DESK</p>
            <h1>内容工作台</h1>
            <p>把一份内容整理成适合不同平台的版本，并在发布前逐项确认。</p>
          </div>
          <div className="header-actions">
            <button className="secondary-action" type="button">
              <Import size={18} />
              导入内容
            </button>
            <button className="primary-action" type="button">
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
          <button className="secondary-action" type="button"><Import size={18} />选择来源目录</button>
        </section>
      </main>
    </div>
  );
}
