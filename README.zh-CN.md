[English](README.md) | [中文](README.zh-CN.md)

# claude-mem-lite

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的轻量级持久化记忆系统。自动捕获编码过程中的观察、决策和问题修复，通过全文搜索随时回溯。

基于 [MCP 服务器](https://modelcontextprotocol.io/) + Claude Code 钩子构建。无需外部服务，单一 SQLite 数据库，开销极低。

## 为什么选择 claude-mem-lite？

对 [claude-mem](https://github.com/thedotmack/claude-mem) 的重新设计，用更智能、更精简的架构替代其重量级方案。

### 架构对比

| | claude-mem（原版） | claude-mem-lite |
|---|---|---|
| **LLM 调用** | 每次工具使用都触发 Sonnet 调用 | 仅在 episode 刷新时调用（5-10 次操作批处理） |
| **LLM 输入** | 原始 `tool_input` + `tool_output` JSON | 预处理后的动作摘要 |
| **对话模式** | 多轮对话，累积完整历史 | 无状态单轮提取 |
| **噪声过滤** | LLM 通过 "WHEN TO SKIP" 提示词判断 | 确定性的代码级 Tier 1 过滤器 |
| **运行方式** | 长驻后台 worker 进程（1.8MB .cjs） | 按需启动，立即退出 |
| **依赖** | Bun + Python/uv + Chroma 向量数据库 | 仅 Node.js（3 个 npm 包） |
| **源码大小** | ~2.3MB 编译后的打包文件 | ~50KB 可读源码 |
| **数据目录** | `~/.claude-mem/` | `~/claude-mem-lite/`（自动迁移） |

### Token 与成本效率

以典型的 50 次工具调用的会话为例：

| | claude-mem | claude-mem-lite | 比率 |
|---|---|---|---|
| LLM 调用次数 | ~50（每次工具使用） | ~5-8（按 episode） | **减少 7-10 倍** |
| 每次调用 token | 1,000-5,000（原始 JSON + 历史） | 200-500（仅摘要） | **减少 5-10 倍** |
| 总 token 量 | ~100K-250K | ~1K-4K | **减少 50-100 倍** |
| 模型成本 | Sonnet ($3/$15 每百万) | Haiku ($0.25/$1.25 每百万) | **便宜 12 倍** |
| 综合节省 | | | **成本降低 600 倍+** |

### 质量对比

| 维度 | 胜出方 | 原因 |
|---|---|---|
| **分类准确性** | 持平 | 两者都能正确生成 type/title/narrative |
| **噪声过滤** | **lite** | 代码级过滤是确定性的；LLM 的 "WHEN TO SKIP" 不可靠 |
| **观察连贯性** | **lite** | Episode 批处理将相关编辑组合为一条连贯的观察 |
| **代码级细节** | 原版 | 能看到完整 diff，但在记忆搜索中很少用到 |
| **搜索召回率** | 持平 | 用户搜索语义概念（"auth bug"），而非代码行 |
| **Hook 延迟** | **lite** | 异步后台 worker；原版每次 hook 阻塞 2-5 秒 |

### 设计理念

原版把**所有数据扔给 LLM，期望它自行过滤**。claude-mem-lite **先用代码过滤，再把真正重要的内容**发送给更小的模型。这不是降级，而是更智能的架构——以极低的成本产出同等的搜索质量。

## 功能特性

- **自动捕获** -- 挂载到 Claude Code 生命周期（PostToolUse、SessionStart、Stop、UserPromptSubmit），无需手动操作即可记录观察
- **FTS5 搜索** -- 基于 BM25 排名的全文搜索，覆盖观察、会话摘要和用户提示，支持重要度加权
- **时间线浏览** -- 基于锚点的时间上下文窗口，按时间顺序浏览观察
- **Episode 批处理** -- 将相关文件操作分组为连贯的 episode，再进行 LLM 编码
- **错误触发回忆** -- Bash 出错时自动搜索记忆，浮现相关的历史修复方案
- **主动文件历史** -- 编辑文件时，自动显示该文件相关的历史观察记录
- **会话摘要** -- 会话结束时通过后台 worker（使用 `claude -p`）生成 LLM 摘要
- **项目作用域上下文** -- 将最近的记忆注入 `CLAUDE.md` 和会话启动上下文
- **观察类型** -- 分类为 `decision`、`bugfix`、`feature`、`refactor`、`discovery` 或 `change`
- **重要度分级** -- LLM 为每条观察分配 1-3 级重要度（日常/关注/关键）
- **观察关联** -- 基于文件重叠自动建立观察之间的双向链接
- **用户提示捕获** -- 通过 UserPromptSubmit 钩子记录用户提示，追踪用户意图
- **Read 文件追踪** -- 追踪会话中读取的文件，丰富 episode 上下文
- **零数据丢失** -- LLM 失败时，使用推断的元数据保存降级记录，而非丢弃
- **两级去重** -- Jaccard 相似度（5 分钟窗口）+ MinHash 签名（7 天跨会话窗口）双重防重
- **同义词扩展** -- 缩写如 `K8s`、`DB`、`auth` 在 FTS5 搜索时自动扩展为全称（48+ 对）
- **伪相关反馈（PRF）** -- 首轮结果作为种子扩展查询，提升召回率
- **概念共现** -- 观察间的共享概念自动扩展搜索到相关主题
- **上下文感知重排** -- 活跃文件重叠提升相关性（精确匹配 + 目录级半权重）
- **过时检测** -- 当更新的观察覆盖相同文件且重要度更高时，标记旧观察为已取代
- **自适应时间窗口** -- 会话启动回忆使用基于速率的时间窗口（高/中/低活跃度分级）
- **Token 预算上下文** -- 贪心背包算法在 2,000 token 预算内选择会话启动上下文，按时效性和重要度优先
- **观察压缩** -- 可将旧的低价值观察压缩为每周摘要，减少噪声
- **秘密擦除** -- 自动编辑 API 密钥、token、PEM 块、数据库连接字符串等 15+ 种凭证模式
- **原子写入** -- 所有文件写入（episode、CLAUDE.md）使用 write-to-tmp + rename 防止崩溃时损坏
- **健壮锁机制** -- PID 感知的锁文件，自动清理过期（>30s）或孤儿（PID 已死）锁
- **过期会话清理** -- 活跃超过 24 小时的会话在下次启动时自动标记为 abandoned

## 环境要求

- **Node.js** >= 18
- **Claude Code** CLI 已安装并配置（`claude` 命令可用）
- **SQLite3** 支持（由 `better-sqlite3` 提供，安装时编译）

## 安装

### 方式一：插件市场（推荐）

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

插件系统会处理一切：钩子、MCP 服务器和依赖安装（通过 Setup 钩子）。依赖会在首次运行时自动安装。

### 方式二：npx（一行命令）

```bash
npx github:sdsrss/claude-mem-lite
```

源文件会自动复制到 `~/claude-mem-lite/` 以持久化保存。

### 方式三：git clone

```bash
git clone https://github.com/sdsrss/claude-mem-lite.git
cd claude-mem-lite
node install.mjs install
```

源文件保留在克隆的仓库中。通过 `git pull && node install.mjs install` 更新。

### 安装过程

1. **安装依赖** -- `npm install --omit=dev`（编译原生 `better-sqlite3`）
2. **注册 MCP 服务器** -- `mem` 服务器，包含 7 个工具（search、timeline、get、save、stats、delete、compress）
3. **配置钩子** -- `PostToolUse`、`SessionStart`、`Stop`、`UserPromptSubmit` 生命周期钩子
4. **创建数据目录** -- `~/claude-mem-lite/`，存放数据库和运行时文件
5. **自动迁移** -- 如果 `~/.claude-mem/`（原版 claude-mem）存在，自动将数据库和运行时文件复制到 `~/claude-mem-lite/`，原目录保持不变
6. **初始化数据库** -- SQLite WAL 模式，FTS5 索引在服务器首次启动时创建

安装后重启 Claude Code 以激活。

### 从 claude-mem（原版）迁移

所有安装方式都会自动检测 `~/.claude-mem/` 并迁移：
- 复制 `claude-mem.db` → `~/claude-mem-lite/claude-mem-lite.db`（重命名）
- 复制 `runtime/` 目录
- **原 `~/.claude-mem/` 保持不变**（不删除、不覆盖）
- 已有的 `~/claude-mem-lite/claude-mem.db` 会在首次运行时自动重命名为 `claude-mem-lite.db`

确认一切正常后手动删除旧目录：
```bash
rm -rf ~/.claude-mem/
```

### 目录结构

```
~/claude-mem-lite/
  claude-mem-lite.db       # SQLite 数据库（WAL 模式）
  runtime/
    session-<project>    # 活跃会话状态
    ep-<project>.json    # Episode 缓冲区
    ep-flush-*.json      # 已刷新的 episode，等待处理
    reads-<project>.txt  # Read 文件路径（刷新时收集）
```

## 使用方法

### MCP 工具（由 Claude 自动使用）

| 工具 | 描述 |
|------|------|
| `mem_search` | 基于 BM25 排名的 FTS5 全文搜索。支持按类型、项目、日期范围、重要度过滤。 |
| `mem_timeline` | 围绕锚点按时间顺序浏览观察。 |
| `mem_get` | 获取指定观察 ID 的完整详情（包含重要度和关联 ID）。 |
| `mem_save` | 手动保存记忆/观察。 |
| `mem_stats` | 查看统计：计数、类型分布、热门项目、每日活动。 |
| `mem_delete` | 按 ID 删除观察，支持预览/确认工作流。FTS5 自动清理。 |
| `mem_compress` | 压缩旧的低价值观察为每周摘要，减少噪声。 |

### 技能命令（在 Claude Code 聊天中使用）

```
/mem search <query>        # 全文搜索所有记忆
/mem recent [n]            # 显示最近 N 条观察（默认 10）
/mem save <text>           # 保存手动记忆/笔记
/mem stats                 # 显示记忆统计
/mem timeline <query>      # 围绕匹配结果浏览时间线
/mem <query>               # search 的简写
```

### 高效搜索工作流

```
1. mem_search(query="auth bug")     -> 紧凑的 ID 索引
2. mem_timeline(anchor=12345)       -> 周边上下文
3. mem_get(ids=[12345, 12346])      -> 完整详情
```

## 数据库结构

四张核心表 + FTS5 虚拟表用于搜索：

**observations** -- 单条编码观察（决策、bug修复、功能等）
```
id, memory_session_id, project, type, title, subtitle,
text, narrative, concepts, facts, files_read, files_modified,
importance, related_ids, created_at, created_at_epoch
```

**session_summaries** -- LLM 生成的会话摘要
```
id, memory_session_id, project, request, investigated,
learned, completed, next_steps, files_read, files_edited, notes
```

**sdk_sessions** -- 会话追踪
```
id, content_session_id, memory_session_id, project,
started_at, completed_at, status, prompt_counter
```

**user_prompts** -- 通过 UserPromptSubmit 钩子捕获的用户提示
```
id, content_session_id, prompt_text, prompt_number
```

FTS5 索引：`observations_fts`、`session_summaries_fts`、`user_prompts_fts`

## 工作原理

### Hook 管线

```
SessionStart
  -> 生成会话 ID
  -> 标记过期会话（活跃 >24h）为 abandoned
  -> 清理孤儿/过期锁文件
  -> 查询最近观察（24 小时内）
  -> 注入上下文到 CLAUDE.md + 标准输出

PostToolUse（每次工具执行）
  -> Bash 预过滤器 ~5ms 跳过噪声（Read 路径追踪到 reads 文件）
  -> 检测 Bash 重要性（错误、测试、构建、git、部署）
  -> 累积到 episode 缓冲区
  -> 主动文件历史：为编辑的文件显示过往观察
  -> 刷新条件：缓冲区满（10 条） | 5 分钟间隔 | 上下文切换
  -> 刷新时收集 Read 文件路径到 episode
  -> 为有意义的 episode 启动 LLM episode worker
  -> 错误触发回忆：搜索记忆中相关的历史修复

UserPromptSubmit
  -> 捕获用户提示文本到 user_prompts 表
  -> 递增会话提示计数器
  -> 纯数据库操作，<100ms

Stop
  -> 刷新最终 episode 缓冲区
  -> 标记会话为已完成
  -> 启动 LLM 摘要 worker（轮询等待）
```

### Episode 编码

Episode 是一批相关操作（对同一组文件的编辑），由后台 LLM worker 处理：

```
Episode 缓冲区 -> 刷新为 JSON -> claude -p --model haiku -> 结构化观察 -> SQLite
```

每条观察包含类型、标题、叙述、概念、事实和重要度（1-3），并通过两级机制自动去重：Jaccard 相似度（5 分钟内 >70%）和 MinHash 签名（7 天跨会话 >80%）。LLM 调用失败时，使用推断的元数据保存降级记录（零数据丢失）。相关观察通过 FTS5 标题相似度和文件重叠自动建立 `related_ids` 链接。

## 管理命令

```bash
# 插件安装：
/plugin install claude-mem-lite       # 安装 / 更新
/plugin uninstall claude-mem-lite     # 卸载

# git clone 安装：
node install.mjs install              # 安装并配置
node install.mjs uninstall            # 移除（保留数据）
node install.mjs uninstall --purge    # 移除并删除所有数据
node install.mjs status               # 显示当前状态
node install.mjs doctor               # 诊断问题

# npx 安装：
npx claude-mem-lite                   # 安装 / 重新安装
npx claude-mem-lite uninstall         # 移除（保留数据）
npx claude-mem-lite doctor            # 诊断问题
```

### doctor

检查 Node.js 版本、依赖、服务器/钩子文件、数据库完整性、FTS5 索引和残留进程。

### status

显示 MCP 注册状态、钩子配置和数据库统计（观察/会话数量）。

## 卸载

```bash
# 插件：
/plugin uninstall claude-mem-lite

# git clone：
cd claude-mem-lite
node install.mjs uninstall            # 保留 ~/claude-mem-lite/ 数据
node install.mjs uninstall --purge    # 删除 ~/claude-mem-lite/ 及所有数据

# npx：
npx claude-mem-lite uninstall
npx claude-mem-lite uninstall --purge
```

数据默认保留在 `~/claude-mem-lite/` 中。如需删除：
```bash
rm -rf ~/claude-mem-lite/
```

## 项目结构

```
claude-mem-lite/
  .claude-plugin/
    plugin.json      # 插件清单
    marketplace.json # 市场目录
  .mcp.json          # MCP 服务器定义（插件模式）
  hooks/
    hooks.json       # 钩子定义（插件模式）
  commands/
    mem.md           # /mem 命令定义
  scripts/
    setup.sh         # Setup 钩子：npm install + 迁移
  server.mjs           # MCP 服务器：工具定义、FTS5 搜索、数据库初始化
  server-internals.mjs # 搜索辅助模块：重排序、PRF、概念扩展
  hook.mjs             # Claude Code 钩子：episode 捕获、错误回忆、会话管理
  schema.mjs           # 数据库 schema：表、迁移、FTS5 的单一事实来源
  tool-schemas.mjs     # 共享 Zod schema，用于 MCP 工具校验
  utils.mjs            # 共享工具：FTS5 查询构建、MinHash 去重、秘密擦除
  install.mjs          # CLI 安装器：设置、卸载、状态、诊断（npx/git clone 模式）
  skill.md             # MCP 技能定义（npx/git clone 模式）
  package.json         # 依赖和元数据
  # 测试和基准（仅开发）
  *.test.mjs           # 单元、属性、集成、契约、E2E 测试（323 个）
  test-helpers.mjs     # 共享测试工具
  benchmark/           # BM25 搜索质量基准 + CI 门控
```

## 搜索质量

基于 200 条观察和 30 个查询（标准 + 困难负样本类别）的基准测试结果：

| 指标 | 得分 |
|------|------|
| Recall@10 | 0.88 |
| Precision@10 | 0.96 |
| nDCG@10 | 0.95 |
| MRR@10 | 0.95 |
| P95 搜索延迟 | 0.15ms |

基准测试作为 CI 门控运行（`npm run benchmark:gate`），防止搜索质量回退。

## 开发

```bash
npm run lint              # ESLint 静态分析
npm test                  # 运行全部 323 个测试（vitest）
npm run test:smoke        # 运行 5 个核心冒烟测试
npm run test:coverage     # 运行测试并生成 V8 覆盖率（≥70% 行/函数，≥60% 分支）
npm run benchmark         # 运行完整搜索质量基准测试
npm run benchmark:gate    # CI 门控：指标回退超过 5% 容差时失败
```

## 许可证

MIT
