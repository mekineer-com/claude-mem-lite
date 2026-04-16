// Phase C (Invited-Memory plan, T10): Content generators for the
// claude-mem-lite sentinel line and its companion plugin_claude_mem_lite.md
// detail doc. Kept separate so the strings are testable without side effects
// and can evolve without touching memdir.mjs primitives.
//
// Bumping CURRENT_SENTINEL_VERSION: pick the next vN and update
// docs/plans/2026-04-16-invited-memory-pattern.md so installs do a version-
// bump replace instead of treating the old content as a user edit.

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

> 由 \`claude-mem-lite adopt\` 生成；卸载用 \`claude-mem-lite unadopt\`。
> 设计背景见 docs/plans/2026-04-16-invited-memory-pattern.md。

## 何时调用 MCP 工具

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
- "清理过期记忆" → \`mem_maintain\`
- "FTS 索引健康吗" → \`mem_fts_check\`
- "按 tier 浏览" → \`mem_browse\`
- "备份导出" → \`mem_export\`

## CLI 速查

| 命令 | 用途 |
|------|------|
| \`claude-mem-lite search "query"\` | FTS5 全文搜索 |
| \`claude-mem-lite search "err" --type bugfix\` | 按类型过滤 |
| \`claude-mem-lite recall "file.mjs"\` | 文件相关记忆 |
| \`claude-mem-lite recent 5\` | 最近 5 条 |
| \`claude-mem-lite get 42,43\` | 按 ID 展开 |
| \`claude-mem-lite timeline --anchor 42\` | 时间线上下文 |

## 质量门槛

- \`mem_save\` 的 \`lesson_learned\` 不要写 \`none\`——写不出教训就保持 NULL
- \`decision\` 命中率 72.7% vs \`change\` 16.5%——一条好 decision ≈ 20 条 change
- 一般搜索跳过 \`obs_type\` 让系统自动路由；特定意图再过滤

## 卸载

\`claude-mem-lite unadopt\` 精确移除 sentinel 段 + 本文件；其它 MEMORY.md 内容不动。
`;
}
