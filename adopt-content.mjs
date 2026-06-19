// Phase C (Invited-Memory plan, T10): Content generators for the
// claude-mem-lite sentinel line and its companion plugin_claude_mem_lite.md
// detail doc. Kept separate so the strings are testable without side effects
// and can evolve without touching memdir.mjs primitives.
//
// Bumping CURRENT_SENTINEL_VERSION: pick the next vN and update
// docs/plans/2026-04-16-invited-memory-pattern.md so installs do a version-
// bump replace instead of treating the old content as a user edit.

import { CLI_INVOKE } from './cli-path.mjs';

export const PLUGIN_SLUG = 'claude-mem-lite';
export const CURRENT_SENTINEL_VERSION = 'v1';

/**
 * One-line entry injected into MEMORY.md's sentinel section. Must stay ≤150
 * chars so it clears Claude Code's 200-line MEMORY.md cap with headroom.
 */
export function getIndexLine() {
  return '- [claude-mem-lite](plugin_claude_mem_lite.md) — Edit 前 `mem_recall(file=…)`；bugfix 后 `mem_save(type="bugfix", lesson_learned, importance=2)`';
}

/**
 * Full detail doc rendered into `memdir/plugin_claude_mem_lite.md`. Not
 * auto-loaded by Claude Code — the MEMORY.md index line points to it and
 * Claude reads it on demand when the injected hint suggests relevance.
 */
export function getDetailDoc() {
  return `# claude-mem-lite 插件契约

> 由 \`${CLI_INVOKE} adopt\` 生成；卸载用 \`${CLI_INVOKE} unadopt\`。
> 设计背景见 docs/plans/2026-04-16-invited-memory-pattern.md。

## 何时调用 MCP 工具

以下 6 个核心 MCP 工具在 \`tools/list\` 中默认暴露，覆盖了契约的热路径：
\`mem_search\` / \`mem_recent\` / \`mem_recall\` / \`mem_get\` / \`mem_save\` / \`mem_timeline\`。

| 时机 | 工具 | 关键参数 |
|------|------|----------|
| Edit / Write 前 | \`mem_recall\` | \`file="<路径>"\` —— 过往 bugfix 与教训 |
| Test failure / error | \`mem_search\` | \`query="<错误关键词>", obs_type="bugfix"\` |
| Refactor 前 | \`mem_search\` | \`query="<模块>", obs_type="refactor"\` |
| 新功能起手 | \`mem_search\` | \`query="<功能区域>"\` —— 找 prior art |
| Bugfix 解决后 | \`mem_save\` | \`type="bugfix", lesson_learned="<根因+修法>", importance=2\` |
| 架构决策后 | \`mem_save\` | \`type="decision", lesson_learned="<取舍理由>", importance=2\` |
| 上下文提到 #NN | \`mem_get\` | \`ids=[NN]\` |

## Decision rules（替代多步 search）

- "最近做了啥" → \`mem_recent\`
- "<文件> 有哪些记忆" → \`mem_recall\`
- "#NN 前后发生了啥" → \`mem_timeline\`

## 维护 / 管理类工具（走 CLI）

v2.34.0 起，以下 11 个工具从 \`tools/list\` 中隐藏以缩小启动上下文；它们仍注册在
MCP 层，按名 \`tools/call\` 仍可命中，但对 Claude Code 这类只读 tools/list 的
调用方只走下面的 CLI 入口：

| 场景 | CLI |
|------|-----|
| 清理过期记忆 | \`${CLI_INVOKE} maintain scan --ops purge_stale\` → \`maintain execute --ops purge_stale --confirm\`（execute 删行必须带 \`--confirm\`，否则只预览） |
| 深度优化（Haiku） | \`${CLI_INVOKE} optimize\`（默认 preview；\`--run\` 执行，\`--task re-enrich,normalize,cluster-merge,smart-compress\` 选阶段） |
| 压缩旧条目 | \`${CLI_INVOKE} compress\`（默认 preview；\`--execute\` 执行，\`--age-days N\` 改阈值） |
| FTS5 索引检查 / 重建 | \`${CLI_INVOKE} fts-check [--rebuild]\` |
| tier 分组浏览 | \`${CLI_INVOKE} browse [--tier active]\` |
| 导出 JSON/JSONL | \`${CLI_INVOKE} export [--format jsonl]\` |
| 统计总量 / 健康 | \`${CLI_INVOKE} stats [--days 30]\` |
| 删除某条 | \`${CLI_INVOKE} delete <id>[,<id>]\` |
| 更新某条 | \`${CLI_INVOKE} update <id> [--title ...]\` |
| 列 / 搜索 / 导入 skill-agent registry | \`${CLI_INVOKE} registry <list\\|search\\|import>\` |
| 按 registry 名载入 skill/agent | （MCP only：\`mem_use\`；由用户主动请求时才使用） |

## CLI 速查（常用检索）

| 命令 | 用途 |
|------|------|
| \`${CLI_INVOKE} search "query"\` | FTS5 全文搜索 |
| \`${CLI_INVOKE} search "err" --type bugfix\` | 按类型过滤 |
| \`${CLI_INVOKE} recall "file.mjs"\` | 文件相关记忆 |
| \`${CLI_INVOKE} recent 5\` | 最近 5 条 |
| \`${CLI_INVOKE} get 42,43\` | 按 ID 展开 |
| \`${CLI_INVOKE} timeline --anchor 42\` | 时间线上下文 |

## 质量门槛

- \`mem_save\` 的 \`lesson_learned\` 不要写 \`none\`——写不出教训就保持 NULL
- \`decision\` 的命中率高于 \`change\`（当前遥测约 3:1，数值会漂移——用 \`${CLI_INVOKE} stats\` 实测，别套固定倍数）；方向稳健：一条好 decision 抵数条 change
- 一般搜索跳过 \`obs_type\` 让系统自动路由；特定意图再过滤

## 卸载

\`${CLI_INVOKE} unadopt\` 精确移除 sentinel 段 + 本文件；其它 MEMORY.md 内容不动。
`;
}
