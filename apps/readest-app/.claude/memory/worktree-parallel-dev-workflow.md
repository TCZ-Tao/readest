---
name: worktree-parallel-dev-workflow
description: "并行开发第二个功能：为它 pnpm worktree:new 一个 worktree 并在新目录开新对话，绝不在主目录切分支；dev 实例全局同一时间只能跑一个"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-21T00:00:00.000Z
---

一个工作树同一时刻只能检出一个分支。当某个对话/任务已经在某分支上工作（通常还有未提交改动）时，另开任务的方式是：

```bash
pnpm worktree:new <branch>        # 同级目录生成 readest-<branch>，基于 tcz 建分支并备齐一切
# 在新目录上打开新的 AI 对话/工作区
pnpm worktree:rm <branch>         # 结束后清理
```

**Why:** 在共享的主目录里切分支，未提交改动会跟着走或导致切换失败，两个功能混在一起互相踩踏。worktree 给每个任务独立的分支与未提交状态；`worktree:new` 还把 submodule、`pnpm install`、`.env*`、`public/vendor`、Android gen 一次性备齐，并把 Rust `target` junction 回主仓共享（主仓 target 实测 62G，node_modules 走 pnpm store 硬链接）——所以新 worktree 的真实磁盘增量只有几百 MB。这也是禁止裸 `git worktree add` 的最大原因：裸用会失去共享 target 和硬链接依赖，从零装依赖、重编 Rust。

**How to apply:**
- 分支基线默认 `tcz`（fork 集成分支；2026-09-21 起 `worktree-new.ts` 默认 tcz，第二参数可覆盖；PR 数字路径仍走 `origin/main`）。检出已有分支会被 rebase 到基线，不想被改写历史的分支别用 `worktree:new` 检出。
- 一条分支不能同时检出在两个 worktree（报 already checked out）。
- 全局同一时间只跑一个 dev 实例：`target` junction 共享意味着并发 `pnpm tauri dev` 会互相等 cargo 锁（表现为长时间无输出的串行等待，不是报错），dev server 端口也冲突。并行的另一个对话只做改代码、`pnpm test`、`pnpm lint` 这类不冲突的工作。
- 主目录有大量未提交改动时，先提交再开并行任务。
- 按工作区路径隔离的 AI 会话记忆（如 ZCode 项目记忆）不跨 worktree；仓库内 `.claude/memory/` 随检出，每个 worktree 独立一份。

规则的用户可见版本在仓库根 `AGENTS.md`「并行开发与 worktree」一节。Related: [[feedback_use_worktree]], [[worktree-shared-target-stale-plugin-cache]], [[worktree-rm-deinits-shared-git-config]], [[worktree-rebase-submodule-drift]], [[worktree-submodule-origin-is-local-gitdir]].
