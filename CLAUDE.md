<claude-mem-context>
### Last Session
Request: Summarize the coding session for the mem project
Completed: Three discovery investigations were conducted exploring the claude-mem integration, model configuration, and hook syste…
Next: Determine the specific goal or issue to address with the claude-mem integration; run tests to verify API endpoint chang…

</claude-mem-context>

## Auto Memory Search

When working on this project, automatically use `mem_search` in these situations:

1. **Errors**: When a Bash command fails or build/test errors occur, search for related past fixes: `mem_search(query="<error keywords>", obs_type="bugfix")`
2. **New files**: Before making significant changes to a file, search for its history: `mem_search(query="<filename>")`
3. **Architecture decisions**: When facing design choices, check past decisions: `mem_search(query="<topic>", obs_type="decision")`
4. **Stuck/blocked**: When progress stalls, search for similar past work: `mem_search(query="<problem description>")`

Use the 3-step workflow: `mem_search` → `mem_timeline(anchor=ID)` → `mem_get(ids=[...])` for full context.
