# [AGENTS.md](http://AGENTS.md)

本文件面向在本仓库工作的 AI 编码代理（Codex、Cursor、ZCode 等）。根目录是入口；应用级细节见 [apps/readest-app/AGENTS.md](apps/readest-app/AGENTS.md)。

## 项目概述

Readest 是一个开源电子书阅读器（Foliate 的现代重写版），技术栈为 **Next.js 16 + Tauri v2 + React 19 + TypeScript + Rust**，以 pnpm monorepo 组织。支持 EPUB、PDF、MOBI、AZW3、FB2、CBZ、TXT、MD 等格式。

**本仓库是个人使用的 fork**，不是上游主仓。改动以自用为先，不追求向上游贡献的通用性，不需要过于正式的说明。

## 本 fork 的范围（重要）

- **目标平台只有两个：Windows 桌面 + Android。** iOS、macOS、Linux、Web（Cloudflare Workers）的代码保留在树里，但不要为它们做适配、修复或验证，除非明确要求。
- 本地 Android 工具链已就绪：SDK Platform 36.0、NDK 30（tauri CLI 按 `NDK_HOME` 或最高安装版本选择 NDK；CI 锁 28.2.13676358，与本地无关）。
- Windows 上 `pnpm tauri dev` 正常关闭时退出码为 4294967295，是良性噪音，不是错误。



## 仓库结构

```
apps/readest-app/            # 主应用（前端 + Tauri Rust 后端），99% 的改动发生在这里
apps/readest-calibre-plugin/ # Calibre 插件（不在本 fork 维护范围）
apps/readest.koplugin/       # KOReader 插件（不在本 fork 维护范围）
packages/foliate-js/         # 电子书解析引擎（git submodule）
packages/tauri/              # readest 维护的 Tauri fork（git submodule）
packages/simplecc-wasm/      # 中文简繁转换 WASM（git submodule）
packages/js-mdict/           # MDICT 词典库（git submodule）
packages/qcms/               # qcms 色彩管理（git submodule）
packages/turso-ext/          # SQLite 扩展（有上述交叉编译 bug）
docs/                        # 项目文档，含 windows-android-setup.zh-CN.md（Windows+Android 中文环境搭建）
```

注意 `packages/` 下多数是 git submodule。克隆后、构建前必须：

```bash
git submodule update --init --recursive
pnpm install
pnpm --filter @readest/readest-app setup-vendors   # 拷贝 pdf.js / simplecc / jieba 到 public/vendor
```

> ⚠️ **子模块修改警告（AI 代理必读）**
>
> `packages/` 等处的子模块是**独立 git 仓库**，指向 `readest` 组织的远程，**没有 fork 到用户账号下**——对它们的改动无法随主仓库推送，且随时可能被 `git submodule update` 之类的操作冲掉、无法恢复。
>
> **任何需要修改子模块源码的任务，动手前必须先向用户明确警告**：说明改动将落在哪个子模块、无法随主仓提交/推送、需要单独 fork + 提交 + 更新指针。**经用户确认后才能实现，不要默认继续。** 用户确认后，也要注意：先在子模块里创建分支再提交（子模块常处于 detached HEAD，直接 commit 会产生悬空提交）。



## 常用命令

在仓库根目录执行（已代理到 `apps/readest-app`）：


| 命令                                              | 说明                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm tauri dev`                                | Windows 桌面开发（编译 Rust 后端）                                                   |
| `pnpm dev-web`                                  | 仅前端 dev server（不编译 Rust）                                                   |
| `pnpm tauri android dev --host`                 | Android 真机开发                                                               |
| `pnpm test`                                     | 单元测试（vitest + jsdom），在 `apps/readest-app` 下执行                              |
| `pnpm test -- src/__tests__/utils/misc.test.ts` | 跑单个测试文件                                                                    |
| `pnpm lint`                                     | `tsc --noEmit` + Biome lint                                                |
| `pnpm format`                                   | Biome 格式化（根目录执行）                                                           |
| `pnpm fmt:check` / `pnpm clippy:check`          | Rust `cargo fmt --check` / `cargo clippy -D warnings`                      |
| `pnpm worktree:new <branch>`                    | 新建 worktree（自动处理 submodule、依赖、.env、vendor 资产）。**不要直接用** `git worktree add` |


更多测试形态（browser/tauri/android/e2e）见 `apps/readest-app/package.json` 的 scripts。

## 代码风格与提交检查

- JS/TS：Biome（配置在根 `biome.json`）。husky + lint-staged 会在提交时自动格式化。
- Rust：`cargo fmt` + `cargo clippy`，提交前跑 `pnpm fmt:check && pnpm clippy:check`。
- i18n：key-as-content 方案，新 UI 文案不要硬编码到需要翻译的场景，见 `apps/readest-app/docs/i18n.md`。



## 工作约定

1. **先诊断，后修改**：遇到报错先解释原因，经确认再动代码；不要在用户的树上做未经请求的修复。
2. **最小实现**：只写解决当前问题所需的最少代码，不加未被要求的功能、抽象、可配置项和防御式错误处理。
3. **这不是你认识的那家 Next.js**：项目用 Next.js 16，API 与约定可能不同于训练数据。写前端代码前先查 `apps/readest-app/node_modules/next/dist/docs/` 里的对应文档。
4. **UI 改动注意 e-ink 模式与设计系统**：优先使用 `src/components/settings/primitives/` 的现成原语，规则见 [apps/readest-app/DESIGN.md](apps/readest-app/DESIGN.md) 和 app 级 AGENTS.md 的 E-ink 一节。



## 深入阅读

- [apps/readest-app/AGENTS.md](apps/readest-app/AGENTS.md) — 应用级代理说明：源码布局、路径别名、测试策略、worktree 规则
- [apps/readest-app/DESIGN.md](apps/readest-app/DESIGN.md) — UI/UX 设计系统规则
- [docs/debug-mcp.zh-CN.md](docs/debug-mcp.zh-CN.md) — 调试 MCP：让 AI 观察并操作运行中的 app（仅桌面 debug 构建，也是加新调试工具的指南）
- [docs/windows-android-setup.zh-CN.md](docs/windows-android-setup.zh-CN.md) — Windows + Android 环境搭建（含腾讯 Gradle 镜像配置；镜像只配在本机 `~/.gradle/init.d/`，**不要提交进仓库**）
- [CONTRIBUTING.md](CONTRIBUTING.md) — 上游贡献流程与构建前置条件

