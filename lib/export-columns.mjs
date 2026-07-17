// Single source of truth for the observation columns that `export` emits and `restore`
// reads back. Both the CLI (`cmdExport` in mem-cli.mjs) and the MCP `mem_export` tool
// (server.mjs) build their SELECT from this list so the two surfaces can never drift.
//
// v3.42 audit HIGH-2: the MCP export handler had its own narrower 16-column SELECT while
// the CLI export carried 24 — missing exactly the columns cmdRestore reads back
// (text / files_read / search_aliases / cited_count / uncited_streak / injection_count /
// decay_seen_count / last_accessed_at). A backup taken via MCP export then restored via CLI
// silently collapsed every empty-`narrative` row (import-jsonl / cold-start bodies live in
// `text`) to its bare title — unrecoverable AND unsearchable. Sharing one list closes that
// twin-drift class permanently.
//
// Full round-trippable set: content + value-signals (access/cited/uncited/injection/decay)
// + branch + timing. `id` + `memory_session_id` are informational (restore remaps id and
// buckets under a synthetic restore session). Session-idempotency keys (last_decided/
// last_cited_session_id, demoted_at, optimized_at) are intentionally NOT exported — they are
// meaningless after a row is re-bucketed under a restore session. Also intentionally NOT
// exported: `related_ids` (holds observation ids, stale/dangling after restore remaps ids)
// and `discovery_tokens` (a derived retrieval metric, rebuilt by the live system; exporting
// it would freeze a stale value into backups).
export const EXPORT_COLUMNS = [
  'id', 'memory_session_id', 'project', 'type', 'title', 'subtitle', 'narrative', 'text',
  'concepts', 'facts', 'files_read', 'files_modified', 'lesson_learned', 'search_aliases',
  'scope',
  'importance', 'branch', 'access_count', 'cited_count', 'uncited_streak', 'injection_count',
  'decay_seen_count', 'last_accessed_at', 'created_at', 'created_at_epoch',
];

// The SELECT column fragment (comma-joined) — drop into `SELECT ${EXPORT_COLUMNS_SQL} FROM …`.
export const EXPORT_COLUMNS_SQL = EXPORT_COLUMNS.join(', ');
