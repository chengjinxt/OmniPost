# OmniPost

OmniPost 是面向个人创作者的 Windows 10/11 x64 多平台内容工作台。它把来源导入、统一编辑、平台版本生成、人工批准、定时执行和失败诊断放在一个本地桌面应用中。

> 当前版本是可安装、可测试的本地 MVP。平台官方接口连接器仍为 `experimental`：仓库包含合约实现和 Mock 测试，但没有项目所有者的真实 OAuth 凭证、平台审核资格和真实账号冒烟结果，因此不能视为已经完成生产验证。

## 已实现

- Electron + React + TypeScript 桌面壳、托盘常驻、自启动设置和中文界面。
- TipTap Markdown 编辑器、不可变内容修订、平台变体和编辑后自动撤销批准。
- 通用 Markdown、tgexporter、KnowCraft 三种来源导入；媒体复制到本地 SHA-256 内容寻址仓库。
- SQLite 显式迁移、持久任务队列、账号互斥租约、崩溃恢复、内容绑定批准和语义幂等键。
- Electron `safeStorage`/Windows DPAPI 凭证加密；每个平台、每个账号独立的 Playwright Profile。
- 微信公众号、抖音、YouTube、知乎四个实验连接器的能力探测、校验、请求构造和状态回查合约。
- 13 个平台 × 3 种内容类型的能力注册表，按账号资质、Scope 和运行时探测结果安全降级。
- OpenAI-compatible 平台变体生成；AI 只创建变体，不修改原稿，也不会自动批准。
- Medium Markdown/HTML 导出、canonical URL 建议和打开编辑页；不会自动填表或提交。
- Sharp 图片派生、固定依赖版本的 FFmpeg/ffprobe 视频探测与转码工具。
- 可见浏览器辅助引擎、验证码/登录人工接管、显式最终确认、本地截图与 Trace。
- 脱敏 JSONL 诊断日志、30 天运行产物清理、日志导出和产物目录打开。
- electron-builder NSIS 配置、打包后启动冒烟和 Electron E2E。

## 平台状态

| 平台 | 当前实现 | 交付状态 |
|---|---|---|
| 微信公众号 | 官方草稿/发布/状态接口合约；不满足资质时降级 | Experimental，素材上传和真实账号验证待完成 |
| 抖音 | 图文/视频发布及状态接口合约；无权限时人工交接 | Experimental，媒体上传和真实账号验证待完成 |
| YouTube | 视频上传元数据、预约与处理状态合约 | Experimental，当前传输层是可测试请求抽象，真实 multipart/resumable 上传待完成 |
| 知乎 | 文章/想法发布合约；视频明确不支持 | Experimental，需 Publisher 准入及真实账号验证 |
| 视频号、小红书、快手、头条、百家号、CSDN、掘金、Substack | 已建模能力与安全降级策略 | 尚未接入生产适配器；后续按单平台提交扩展 |
| Medium | Markdown/HTML 导出并打开官方编辑页 | Manual handoff only，不自动发布 |

浏览器辅助运行时当前仅为首发四个平台注册安全的可见编辑入口，且没有生产站点选择器。其他平台目前只能使用内容导出/人工交接，不能宣称已经自动发布。

## 安全模型

- Renderer 禁用 Node.js、启用 `contextIsolation` 和沙箱，只能调用 Zod 校验的白名单 IPC。
- IPC 同时校验发送页面 URL；主窗口阻止外部导航、弹窗、WebView 和权限请求。
- 发布批准绑定 revision、平台变体、媒体、账号连接版本、调度时间及平台字段的内容哈希；任一内容字段或账号凭证变化都会使旧计划失效。
- 每次发布由账号、平台、投递模式、有效内容哈希、调度时间和平台字段生成稳定幂等键。
- 平台请求使用可取消超时；提交超时后进入 `UNKNOWN` 并优先查询远端状态，不会直接再次提交。
- 应用退出会先停止调度并等待正在执行的任务，再关闭浏览器和数据库。
- 结构化日志会脱敏常见 Token、Secret、Authorization、URL 用户信息和敏感查询参数。
- 浏览器截图和 Trace 可能包含平台页面内容，只保存在本机运行产物目录，不应直接对外分享。
- 不绕过验证码，不调用逆向私有接口，不隐藏浏览器；辅助发布必须由用户最终确认。

## 只读来源

相邻的 `E:\PerSourceCodeStore\github\chengjinxt\tgexporter` 和 `E:\PerSourceCodeStore\github\chengjinxt\KnowCraft` 是严格只读参考项目。OmniPost 不会在其中创建缓存、日志、数据库、锁文件或构建产物。

导入器会拒绝越界路径、符号链接和目录联接，读取后把所需媒体复制到 OmniPost 自己的数据目录。CI 与测试只使用本仓库内的匿名夹具。

## 开发环境

工具链固定为 Node.js `24.21.0` 和 pnpm `11.25.0`：

```powershell
nvm use 24.21.0
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm verify
```

如果本机没有固定版本，再执行：

```powershell
nvm install 24.21.0
nvm use 24.21.0
```

常用命令：

```powershell
pnpm dev                 # 开发模式
pnpm lint                # ESLint
pnpm typecheck           # Main/Preload/Renderer 类型检查
pnpm test                # 单元与集成测试
pnpm test:browser:e2e    # 使用本机可见 Edge 的浏览器辅助测试
pnpm test:e2e            # Electron E2E
pnpm verify              # lint + typecheck + test + build
pnpm package             # NSIS 安装包 + 打包后启动冒烟
```

浏览器辅助和 Electron E2E 依赖本机安装的 Microsoft Edge。依赖安装统一使用 `pnpm install --frozen-lockfile`。

## 本地数据

运行数据位于 Electron `userData`：

- `omnipost.db`：内容、账号元数据、计划、任务和执行记录；
- `content-store/`：导入媒体与派生文件；
- `browser-profiles/<platform>/<account>/`：独立登录状态；
- `logs/omnipost.jsonl`：脱敏结构化日志；
- `run-artifacts/`：本地截图和 Playwright Trace。

源码中的 [OmniPost.jpg](./OmniPost.jpg) 是品牌原图，不会被构建脚本修改；PNG、ICO 和托盘图标是它的派生文件。

## 发布前仍需完成

- 分别用真实账号完成微信公众号、抖音、YouTube、知乎端到端冒烟，并保存审核记录。
- 补齐各平台 OAuth 授权/刷新、官方媒体上传协议、配额与错误码分类。
- 为后续平台逐个实现适配器和站点选择器；一次提交只引入一个平台或一种接入模式。
- 公开分发前增加 Windows 代码签名、隐私政策、OAuth 审核和安全更新通道。
- 当前自用版本不启用自动更新，也不包含云服务、多租户或团队审核流。
