# OmniPost

OmniPost 是面向个人创作者的 Windows 多平台内容工作台，用于导入、编辑、适配、审核并发布文章、图片和视频。

## 开发环境

```powershell
nvm use 24.21.0
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm verify
```

项目严格只读引用相邻的 `tgexporter` 与 `KnowCraft` 仓库。任何导入行为都只能读取来源并复制到 OmniPost 自己的数据目录。
