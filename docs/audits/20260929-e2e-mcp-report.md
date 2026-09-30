<!-- Archived from the session scratchpad: the E2E real-user round of 2026-09-29 (sub-report "mcp"). Findings were fixed across v6.21.0; the ledger of what was fixed is the v6.21.0 CHANGELOG entry. Paths below pointed into that scratchpad and no longer exist. -->

# MCP server E2E 报告（server.mjs v6.20.0，2026-09-29，branch converge/20260929-e2e-user @ e5085d4）

运行方式：`$SBX/rpc.mjs` 原始换行分隔 JSON-RPC 客户端，`spawn node $REPO/server.mjs`，env 来自 `sbx-env.sh`（HOME/CLAUDE_MEM_DIR 在 `$SBX` 下，CLAUDE_CODE_PATH=mock-claude.mjs），cwd=`$PROJ`（git init + 2 文件 + 1 commit）。每个用例 = `initialize` → `notifications/initialized` → `tools/call {name, arguments}`。
全新 DB 复现用 `CLAUDE_MEM_DIR=$SBX/fresh`。所有 P1 在全新 DB 上都复现过。

## P0
无。没有崩溃、没有数据丢失、没有秘密泄漏：
- 20 个并发 mem_save（单进程）→ 20 个唯一 id；45 个唯一 save 分布在 3 个 server 进程 → 45/45 落库，0 error；10 个相同 payload（同进程）/ 10 个（跨 2 进程）→ 各只落 1 条，其余 "Skipped: similar to existing #N"。
- 畸形 JSON-RPC（非 JSON、无 method、未知 method、arguments 为字符串、batch 数组、id:null、jsonrpc:"1.0"、NUL 字节、空行）→ 进程存活，后续调用正常。
- secret（ghp_/AKIA/sk-ant-）在写入时被替换为 `***`（DB 里直接查过）；`<system-reminder>` / `</claude-mem-context>` 在所有读工具输出里被去掉尖括号。

## P1-1 过滤后为空的查询，在默认 AUTO-deep 模式下把"最近 N 条"当作命中结果返回
复现（全新 DB，先存 3 条：bugfix×2、decision×1）：
```
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mem_search","arguments":{"query":"C"}}}
```
实际：`Found 3 result(s) for "C":` + 全部 3 行（没有任何一行含 token "c"；也没有 escalation 提示）。
同一查询加 `"deep":false` → `Query "C" was filtered (FTS5 keywords/special chars only).`
在 57 行的 DB 上：`{"query":"C"}` → `Found 20 of 57 result(s) for "C"`。
同样触发：`"x"`, `"R"`, `"AND"`, `"NOT OR"`, `"(((("`, `"🚀"`, `"🐛"`, `"->"`, `"=="`, `"a b"`。
另外 `{"query":"x","offset":5}` 会给出 "was filtered" 提示 —— 所以同一个查询，第 1 页说是命中，越界那页又说是被过滤。
预期：返回 "was filtered" 提示（或者按空查询路径标注为 "(no query — listing recent)"）。
置信度：高。原因提示（未验证）：server.mjs 约 559–575 行的提前返回只在 `deepMode === 'normal'` 时生效；formatSearchOutput 的 `qLabel`（约 460 行）只看 `args.query`，不看 `ftsQuery`。

## P1-2 mem_search 带 obs_type、查询 0 命中时，把该类型全部行当作匹配结果列出
```
{"name":"mem_search","arguments":{"query":"segfault","obs_type":"bugfix"}}
```
实际（全新 DB）：`Found 2 result(s) for "segfault":` + 两条 bugfix（"Cache key locale"、"Parser trailing comma"），都不含 segfault。57 行的 DB 上，`{"query":"zzqqxx","obs_type":"decision","deep":false}` → `Found 20 result(s) for "zzqqxx"`。
这正是工具描述里写的首要用途（"Investigating an error keyword with obs_type="bugfix""）。
预期：这是有意设计的"0 命中 → 按类型列出最近"回退（lib/search-core.mjs:1039 `obsTypeFallback`），但输出必须标明，例如 "no match for X — listing recent bugfix"。
置信度：行为本身高；回退是有意设计，缺的是标注。

## P1-3 mem_update 降低 importance 报告成功，但下一次 mem_get 会把它改回去
```
mem_save {...type:"decision"} → #3 (importance 2)
mem_get {"ids":["3"]} ×2
mem_update {"id":3,"importance":1}   → "Updated observation #3: importance"
mem_get {"ids":["3"],"fields":["importance","access_count"]} → importance: 2, access_count: 3
```
直接查 SQLite 确认：update 之后 DB 里是 1；mem_get 之后是 2。任何被读过 ≥2 次的行都会这样。
原因提示：lib/get-core.mjs:194 → search-scoring.mjs:372 `autoBoostIfNeeded`（access_count>=2 且 importance=1 → 2），在读取路径上执行，会覆盖用户显式写入的值。
预期：显式的 mem_update 应当保持不变（或者 update 的回复里提示会被自动提升）。置信度：高。

## P1-4 mem_recall 不按项目隔离，而且只按 basename 匹配
cwd=projA，存 files ["packages/alpha/index.mjs"]（#107）和 ["packages/beta/index.mjs"]（#108）。
```
{"name":"mem_recall","arguments":{"file":"packages/alpha/index.mjs"}}
```
→ `History for index.mjs (2 observations)`，其中 **beta** 的 lesson 排在第一。
`{"file":"packages/gamma/index.mjs"}`（从未被观察过）→ 返回同样 2 条。
从 **projB**（cwd=$SBX/projB，那里没有 index.mjs）→ 返回同样 2 条 projA 的行；`{"file":"a.txt"}` 也返回 projA 的 #3。
mem_recall 没有 `project` 参数；PreToolUse hook 的 recall 会过滤 `o.project = ?`（scripts/pre-tool-recall.js:724），MCP 这一侧不会（lib/recall-core.mjs 的 SQL 没有 project 条件）。
描述里写着 "DO NOT use when: The file is new or has never been edited — no memories will match"——对 index.mjs / README.md / package.json 这类文件是错的。
basename 过度召回是有意设计的（file-edge-match.mjs 注释）；跨项目泄漏看起来不是有意的。置信度：行为高，意图中等。

## P2（描述不准确 / UX）
1. mem_defer_drop 按序号删除后，序号会重新编号：列表 1..4，`drop {id:2}` 删掉 D#4，再 `drop {id:2}` 删掉的是 D#3（原来的第 3 项）。模型拿着一次列表结果按 "2 和 3" 删，会删错；没有重新打开的工具。回复里确实会写出 D#N。
2. mem_defer 接受纯空白标题：`{"title":"   "}` → "Deferred as D#7"，列出来是空行。mem_save（content）和 mem_defer_drop（reason）都会拒绝纯空白。
3. mem_get `fields:["files"]` → "unknown field(s) dropped: files"，但 mem_get 输出的标签就是 `files:`，mem_save 的 schema 也写着 "rendered as `files`"。
4. mem_timeline `anchor:-5` / `0` → 普通文本（非 isError）"Invalid anchor "-5". Expected N, #N, P#N, or S#N."（漏了 E#N）；schema 宣称 integer 最小值为 -9007199254740991。
5. mem_timeline `{"query":"zzqqxx"}` / `{"query":"AND"}` 会悄悄退回 "Timeline (most recent 11)"，不提示查询没有命中。
6. decision 类型的缺 lesson 提示写的是 `lesson_learned="<root cause + fix>"`（bugfix 的措辞）；mem_save 描述里 decision 对应的是 "<constraint + why>"。
7. mem_defer_list 描述写 "You only need one item by id (use mem_get on the obs that closed it, or look up the row directly)"，但 mem_get 直接支持 D#N（它自己的输出也写着 `mem_get ids=["D#<id>"]`）。
8. mem_maintain dedup `merge_ids` 遇到跨项目 [[9,6]]、自身 [[15,15]]、不存在 [[99998,99999]] 时 → "Merged 0 duplicate observations"，不说明原因。
9. mem_delete 预览一条周汇总（#104），只写 "1 observation(s) will be deleted"；执行后是 "Recovered 44 merged/compressed child observation(s) to live" —— 预览没有提前告知这个副作用。
10. 删除一条起替代作用的行（#38）后，被替代的 #35 仍显示 "RETRACTED — superseded by #38. Read #38 instead"（#38 已不存在；#35 在搜索里保持隐藏）。压缩行被删时会恢复子行，supersede 不会。
11. mem_update 修改已被替代（superseded）的行时成功，没有任何警告。
12. mem_browse `{"tier":"archive"}` 无匹配 → "No observations found. Start a coding session to build memory."（DB 里有 58 条存活行）。mem_stats 在 0 行时报告 "Avg importance: 1.00"。
13. 带 `obs_type` / `type` 的部分导出，警告里给的 CLI 补救命令是 `export --format jsonl > backup.jsonl`，丢掉了当前过滤条件。
14. 启动时 DB 不可用 → exit(1)，stderr：对非数据库文件给的是 "Try: rm <db>-wal <db>-shm"（这两个文件并不存在），对只读目录给的是 "retry or reinstall"（实际原因是权限）；两种情况都给了相对路径的 `node install.mjs install`。
15. 搜索 "OR" 带出了 deferred 尾注 "D#8 priority string"（对运算符词做了子串匹配）。
16. 协议层（SDK）：不合法的 JSON 得不到 -32700 回复；省略 `arguments` 的 `tools/call`（即使工具没有必填参数，如 mem_recent）→ "expected object, received undefined"。Claude Code 总会发送 `{}`，所以影响小。

## 验证正常的部分
tools/list = 9 个（search/recent/timeline/get/save/defer/defer_list/defer_drop/recall）；在默认模式下（未设 CLAUDE_MEM_ALL_TOOLS）按名调用全部 9 个隐藏工具成功（delete, stats, compress, maintain, optimize, update, export, fts_check, browse）；CLAUDE_MEM_ALL_TOOLS=1 列出 18 个。
save→search→get→update→search→delete 往返；删除后 search/recent/get/timeline/recall/browse/export 都查不到。
zod 校验：缺必填、类型错误、空字符串、limit 0/-1/1e6、offset -5、ids >20、lesson >500、content >50000、title >200（defer）→ 都是 isError，给出 -32602 的普通文字说明；坏参数之后 server 继续正常服务。
宽松类型转换可用（"3" → 3，ids 用整数/逗号字符串，files 用字符串）。
FTS5 运算符/引号/NEAR/列过滤/`'; DROP TABLE` → 不报错。CJK 1–4 字的子串在不依赖 enrichment（CLAUDE_MEM_SKIP_SAVE_ENRICH=1）时也能命中；emoji 标题可以往返。
10k 字符的查询（回显被截断）、10k 字符的 recall 路径、10.8k 字符的 content → 都正常。
项目隔离：recent/browse/defer_list 按 cwd 取默认项目；短名 "projB" 在 recent/search/export/stats/defer/save 中都能正确解析，且与 "proj" 区分开；supersedes/defer_drop 拒绝跨项目 id 并说明原因。
Deferred：defer/list/limit/drop（按序号和 D#）、在 open/dropped 状态上用 closes_deferred（dropped→done 会保留 previously_dropped）、非法 id 会让整个 save 回滚。
mem_compress 预览/执行（44 条老化行 → 1 条周汇总，旧 id 的 mem_get/timeline 会重定向）；删除汇总会恢复子行。mem_maintain scan/execute/purge_stale 预览+confirm/vacuum/dedup；mem_optimize 在拿到垃圾 LLM 输出时安全失败（0 merged）；fts_check check/rebuild。
清理：真实的 ~/.claude-mem-lite DB 中 0 行来自本次测试；仓库的 git status 是干净的。
