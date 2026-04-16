# Invited Memory — Plugin ↔ Claude Code 结合度强化

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 claude-mem-lite 中加入 "邀请式 memory 注入" 机制——用户 opt-in 后，一条 `≤150` 字符的动作锚定行进入 `~/.claude/projects/<encoded>/memory/MEMORY.md`，被 Claude Code 原生以 `user's auto-memory` 框定注入系统提示，提升插件 tool 的主动调用率；同时**保守路径（SessionStart hook stdout / UserPromptSubmit 注入 / PreToolUse mem_recall / MCP instructions）不删**，作为 auto-memory 未启用环境的兜底。模式本身通用，可复用到其它插件项目。

**Architecture:** 四阶段，Phase A 独立可交付。

- **Phase A (保守层降噪开关)** — 加 `MEM_QUIET_HOOKS` env + `~/.claude-mem-lite/config.json` 开关，用户未 adopt 前也可以手动让 hook/MCP instructions 瘦身。独立 ship 为 patch 版本。
- **Phase B (memdir 基础设施)** — `memdir.mjs` 提供：项目路径编码、`MEMORY.md` sentinel 段读写、hash 校验、详情文件生成。纯函数，无副作用 I/O 之外的依赖。
- **Phase C (adopt CLI)** — `claude-mem-lite adopt / unadopt / --all / --status / --force`。`install.mjs` 仅对本仓库 dogfood auto-adopt，其它项目手动。
- **Phase D (条件联动)** — `server.mjs` / `hook-context.mjs` runtime 检测 sentinel 存在 → 输出精简版 instructions；否则完整版。

**Non-goals (explicit):**
- ❌ install 时对用户任意项目静默写 `memory/` — 违反用户领地原则
- ❌ 修改 `~/.claude/CLAUDE.md` — 跨所有项目污染
- ❌ 删除保守层源码 — 必须保留兜底
- ❌ 跨插件共享 sentinel 协议 — 各管各（但模式可复用）
- ❌ 基于 `claude --version` 做 auto-memory 可用性 gate — 版本映射不稳；改用 "adopt 时检测目录存在 + 用户 --force 覆盖"
- ❌ 主动扫描 `~/.claude/projects/*` 批量 adopt 除非用户 `--all`
- ❌ `adopt` 落回用户编辑的 MEMORY.md — hash 不匹配即保留不改

**Tech Stack:** Node.js ESM, better-sqlite3 (已有), vitest, zero new runtime deps.

**Version target:**
- Phase A ship 为 **v2.31.3** (patch, 零行为变化 unless user sets env)
- Phase B+C ship 为 **v2.32.0** (MINOR — 新 CLI subcommand group)
- Phase D ship 为 **v2.32.1** (patch — 条件 runtime 分支)

**Est. LOC / duration:** ~750 LOC 新增 + ~150 LOC 修改 across 4 new files + 5 modified + 4 new test files；~4 个工作日。

---

## Preconditions / AUTH gates

1. **Soft AUTH (Phase A)** — `MEM_QUIET_HOOKS=1` 行为默认关闭；用户显式 opt-in。不改默认输出。
2. **Soft AUTH (Phase B+C)** — 新 CLI subcommand + 新模块文件；`install.mjs` 仅对 `package.name === 'claude-mem-lite'` 且 `PROJECT_DIR` 指向本仓库（git remote match）时 auto-adopt。
3. **[AUTH REQUIRED op:modify-mcp-instructions-runtime-branch scope:server.mjs,hook-context.mjs risk:user-facing-system-prompt-content-changes-based-on-sentinel-detection]** — Phase D 让 MCP instructions 和 SessionStart additionalContext 的输出量取决于 sentinel 是否存在；需用户确认 "已 adopt 即精简" 的交互符合预期。
4. **Not touched:** `~/.claude/CLAUDE.md`, 用户 `MEMORY.md` 的非 sentinel 段, 其它插件的 memory 文件。

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `docs/plans/2026-04-16-invited-memory-pattern.md` | this file | plan |
| `memdir.mjs` | CREATE | 路径编码、sentinel IO、hash 校验、adopted detection |
| `adopt-content.mjs` | CREATE | 生成 `plugin_claude_mem_lite.md` 详情内容 + MEMORY.md 索引行文本 |
| `mem-cli.mjs` | MODIFY | 注册 `adopt` / `unadopt` / `adopt --all/--status/--force` 子命令 |
| `install.mjs` | MODIFY | 检测 dogfood 仓库 → 调用 adopt；`uninstall` 调用 unadopt |
| `server.mjs` | MODIFY | MCP instructions runtime 条件分支（Phase D） |
| `hook-context.mjs` | MODIFY | SessionStart `additionalContext` 条件分支（Phase D） |
| `hook.mjs` | MODIFY | 读 `MEM_QUIET_HOOKS` env（Phase A） |
| `README.md` / `README.zh-CN.md` | MODIFY | 文档 adopt 流程 + env 开关 |
| `commands/adopt.md` | CREATE | `/adopt` slash command（可选，Phase C 后） |
| `tests/memdir.test.mjs` | CREATE | 路径编码 fixture + sentinel IO 单测 |
| `tests/adopt-cli.test.mjs` | CREATE | adopt/unadopt E2E 用 tmp memory dir |
| `tests/quiet-hooks.test.mjs` | CREATE | Phase A env 开关行为测试 |
| `tests/adopted-detection.test.mjs` | CREATE | Phase D 条件分支输出差异 |

---

## Task Ordering Rationale

1. **Phase A 独立**：env 开关不依赖 memdir / CLI，先 ship 有独立用户价值（降噪）。
2. **memdir.mjs 先于 CLI**：纯函数模块，testable in isolation，是 CLI 的基础。
3. **CLI 先于 install 集成**：手动命令先可用，再把 auto-adopt 串到 install。
4. **Phase D 最后**：条件分支依赖 adopt 状态，必须 Phase C 产出可读的 sentinel 后才能实现。

---

## Tasks

### Phase A — 保守层降噪开关 (独立可 ship)

- [x] **T1. 定义 `MEM_QUIET_HOOKS` 语义**  
  在 `hook-shared.mjs` 加 exported 常量 `QUIET_HOOKS = process.env.MEM_QUIET_HOOKS === '1'`。定义含义：`=1` 时 SessionStart additionalContext 去掉 `### File Lessons` 描述段只留表格；UserPromptSubmit 注入只保留 ID/title（去掉 why 解释）；MCP instructions 去掉 `WHEN TO USE` 段。

- [x] **T2. 应用到 hook-context.mjs / user-prompt-search.js / server.mjs (via server-internals)**  
  三处根据 `QUIET_HOOKS` 分支输出。保留完整版作为 else 分支，不修改默认行为。

- [x] **T3. 单测 Phase A**  
  `tests/quiet-hooks.test.mjs`：env 未设 → 完整输出；env=1 → 字节数下降 ≥ 30%（具体数值以 golden fixture baseline 为准）；env=1 时 MEMORY.md 指示性单行仍保留。

- [x] **T4. README 文档化**  
  两个 README 加一节 "Reducing hook noise"，说明 env 及其适用场景（已用户手动掌握记忆流程 / 已 adopt）。

### Phase B — memdir 基础设施

- [x] **T5. `memdir.mjs` 路径编码**  
  `encodeProjectPath(absolutePath: string): string` — 非字母数字字符 (`[^a-zA-Z0-9]`) 全部替换为 `-`，开头保留 `-`（匹配 `/home/sds/.claude/projects/-mnt-data-ssd-...` 观测格式）。优先尝试环境：若 `CLAUDE_PROJECT_DIR` 存在则用它，否则 `process.cwd()`。

- [x] **T6. memdir.mjs sentinel IO**  
  - `memdirPath(cwd?): string` — 返回 `~/.claude/projects/<encoded>/memory/`
  - `readMemoryIndex(memdir): { raw: string, pluginSection: string | null, pluginHash: string | null }` — parse `<!-- claude-mem-lite:begin v<N> -->` / `<!-- claude-mem-lite:end -->` 之间内容，hash 用 SHA-256。
  - `writePluginSection(memdir, { slug, version, contentLine })` — 若已存在且 hash 匹配上一版写入 → 替换；不匹配（用户改过）→ throw `UserEditedError`；不存在 → 追加到 MEMORY.md 末尾独立 `## 插件契约` section。
  - `removePluginSection(memdir, slug)` — 精准 sentinel 段删除；段外内容不动。

- [x] **T7. memdir.mjs 详情文件 IO**  
  `writePluginDoc(memdir, slug, markdown)` / `removePluginDoc(memdir, slug)` — 目标文件名 `plugin_<slug_snake>.md`。与 sentinel 段独立，不要求同步。

- [x] **T8. memdir.mjs adoption detection**  
  `isAdopted(memdir, slug): boolean` — 只要 sentinel 段存在就算 adopted（hash mismatch 也算，用户可能 opt-in 后手改）。

- [x] **T9. 单测 memdir**  
  `tests/memdir.test.mjs` — fixtures:
  - 编码: `/mnt/data_ssd/dev/projects/mem` → `-mnt-data-ssd-dev-projects-mem`（实测 ground truth）
  - 编码: `/Users/alice/Work/proj.v2` → `-Users-alice-Work-proj-v2`
  - 编码: 包含中文 `/home/sds/项目` → 中文字符也转 `-`
  - Sentinel IO: 插入、幂等升级 (`v1` → `v1` 无变化)、版本升级 (`v1` → `v2` 替换)、用户改过 hash 不匹配抛错、删除后段外行保留、`MEMORY.md` 不存在自动创建
  - 200 行预算：写入前预检 MEMORY.md 行数，> 180 拒绝并返回 `BudgetExceeded`

### Phase C — adopt CLI

- [x] **T10. `adopt-content.mjs` 内容生成**  
  导出:
  - `getIndexLine(): string` — 返回 MEMORY.md 里那一行（≤150 字符，动作锚 + tool + 参数）。目前草案：`- [claude-mem-lite](plugin_claude_mem_lite.md) — Edit/Write 前 \`mem_recall(file=…)\`；非平凡 bugfix 后 \`mem_save(type='bugfix', lesson_learned, importance=2)\``。
  - `getDetailDoc(): string` — 完整 CLI 速查 + MCP tool 一句话描述 + decision rules (从 server.mjs `WHEN TO USE` 段迁移)。
  - `CURRENT_SENTINEL_VERSION = 'v1'`。

- [x] **T11. `mem-cli.mjs` 注册 adopt group**  
  新增子命令:
  - `adopt` — 当前 CWD 对应 memdir 写入。参数: `--force`（hash mismatch 强制覆盖）、`--dry-run`（打印即写内容但不落盘）。
  - `adopt --all` — 扫描 `~/.claude/projects/*/memory/` 所有存在的，逐个 adopt；跳过 hash mismatch（或 `--force` 强制）。
  - `adopt --status` — 列出所有 adopted 项目 + 版本号 + hash 状态。
  - `unadopt` — 当前 CWD 对应 memdir 移除。
  - `unadopt --all` — 全部移除。

- [x] **T12. adopt CLI E2E 测试**  
  `tests/adopt-cli.test.mjs`：
  - 临时 HOME 指向 tmp dir，写一个假项目 CWD
  - `adopt` → 验证 `<tmp>/.claude/projects/<encoded>/memory/MEMORY.md` 有 sentinel 段且 plugin_claude_mem_lite.md 存在
  - 再 adopt 一次 → 幂等（hash 一致，无 write）
  - 改 sentinel 段 → adopt 报 `UserEditedError`；`--force` 覆盖
  - `unadopt` → sentinel 段消失，段外内容不变
  - `adopt --all` 扫描 3 个 project → 全写入

- [x] **T13. install.mjs 集成**  
  `install.mjs`:
  - `install()` 末尾：检测 `PROJECT_DIR` 的 git remote 是否匹配 `claude-mem-lite` 官方仓库 (`github.com/sdsrss/claude-mem-lite`)；匹配则 auto-adopt 本项目（dogfood）。不匹配不做任何事。
  - `uninstall()`：无论哪个项目，不自动 unadopt（避免删用户已 adopt 的其它项目）。输出提示 "如需移除 adopt：claude-mem-lite unadopt --all"。
  - 加 `--no-adopt` flag override auto-adopt。

### Phase D — 条件联动 (MCP + hook 瘦身)

- [x] **T14. server.mjs runtime sentinel 检测**  
  服务启动时检查 `memdirPath(cwd).isAdopted('claude-mem-lite')`；adopted → MCP server instructions 去掉 `WHEN TO USE` 全段（由 adopted detail doc 替代）；未 adopted → 完整版。由于 MCP server 是每会话起的，检测一次即可。

- [x] **T15. hook-context.mjs SessionStart additionalContext 条件**  
  已 adopted → `startup-dashboard` 省略 "memory usage hints" 段；未 adopted → 含完整 hints。

- [x] **T16. 单测条件联动**  
  `tests/adopted-detection.test.mjs`：同一 startup-dashboard builder 在 adopted/未 adopted 两种 memdir 状态下输出 diff；差量为预期的 hints 段。

### Phase E — 文档 + 其它插件复用

- [x] **T17. `commands/adopt.md` + `commands/unadopt.md` slash commands**  
  用户在 Claude Code 内可用 `/adopt` 直接触发当前项目 adopt。

- [x] **T18. README 专节 "Invited Memory" 说明**  
  解释: 原理、何时 adopt、何时 unadopt、与保守层如何互补、其它 Claude Code 插件如何复用此模式（pointer to `feedback_invited_memory_pattern.md`）。

- [x] **T19. 示例：其它插件 adopt 模板**  
  `docs/templates/invited-memory-template.md` — 空白模板，其它插件 fork 后替换 `<plugin-slug>` / `<index-line>` / `<detail-content>` 即可。

---

## Rollout plan

1. **v2.31.3 (patch)** — ship Phase A 独立。零行为变化 unless `MEM_QUIET_HOOKS=1`。评估一周用户反馈（是否有人手动打开）。
2. **v2.32.0 (minor)** — ship Phase B + C。默认仅本仓库 auto-adopt，其它用户手动。Release notes 明确说明 opt-in 性质 + 卸载方式。
3. **v2.32.1 (patch)** — ship Phase D 条件联动。需 v2.32.0 有真实用户 adopt 一段时间后才合并（避免误伤未 adopt 用户）。
4. **v2.33.0 (minor)** — ship Phase E 文档+其它插件模板。

每阶段 ship 前必须：
- `npx vitest run` 44 test files + 新测试全绿
- `npx eslint .` 无 warning
- 对本仓库手动 `adopt` → `/exit` 重启 Claude Code → 验证 MEMORY.md sentinel 行出现在 system prompt → `unadopt` → 重启验证消失

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| 路径编码不匹配 Claude Code 实现 (`#7687` 教训) | Med | T9 fixture 用本会话观测值做 ground truth；若发现偏差，`memdir.mjs` 提供 `CLAUDE_PROJECT_DIR` env override |
| MEMORY.md 200 行截断挤掉我们的段 | Low | T6 `writePluginSection` 预检 > 180 行拒绝 + 报错让用户清理 |
| 用户编辑 sentinel 段 | Med | hash 校验 + `UserEditedError` + `--force` 明确覆盖 |
| auto-memory 在某些 Claude Code 版本未启用 | Med | 保守层全保留；adopt 后 sentinel 段若不生效，用户体验 ≡ 未 adopt（无负效果） |
| 其它插件抄袭模式造成 memory 污染 | Low | 我们用明确 `<!-- <slug>:begin v<N> -->` sentinel + 限每插件一行；模板示例强化约束 |
| install 自动 adopt 误伤非 dogfood 仓库 | Low | git remote 严格匹配；加 `--no-adopt` override |
| Phase D 瘦身导致未 adopt 用户看不到 hints | High if misimplemented | 运行时 sentinel 检测 → 未 adopt 走完整版分支；单测覆盖两路径 |

---

## Open questions

1. **MEMORY.md 索引行位置**：append 到末尾新建 `## 插件契约` section，还是 insert 到已有 `## 用户偏好` section？  
   → 建议独立 `## 插件契约`，避免与用户自写 feedback 混淆；其它插件共享该 section。
2. **`adopt --all` 默认行为**：只扫描有内容的 memdir (MEMORY.md 存在) 还是创建空 memdir 也 adopt？  
   → 建议只扫描已存在，避免在用户未使用 auto-memory 的项目凭空创建。
3. **多插件共存时 MEMORY.md 200 行预算如何协调**？  
   → 非本插件职责，但 T6 的 budget check 会提示用户；长期可能需要社区共识的 `plugins.md` 单独文件约定。
4. **`CLAUDE_PROJECT_DIR` env 是否一定由 Claude Code 注入**？  
   → 本会话无法验证全版本。T5 先依赖 CWD，若后续发现 env 更稳再切换。
5. **`adopt` 应该 per-plugin 还是引入统一协议**？  
   → 本 plan 只做 per-plugin；若多个 sdsrss 插件合用，后续抽 `invited-memory-kit` npm 包复用。

---

## Decision log

- **2026-04-16 初版**：sentinel-wrapped 单行、opt-in adopt、保守层不删、Phase D 条件瘦身；auto-memory 被判定为 Claude Code 运行时注入（非用户 CLAUDE.md 配置），但为安全仍保留 fallback。
- **保留的替代方案**：写 `~/.claude/CLAUDE.md` 全局注入 — 已否决（跨项目污染、侵入用户全局指令）。
- **保留的替代方案**：写项目 CLAUDE.md — 已否决（受版本控制，checked in 会污染协作者）。
