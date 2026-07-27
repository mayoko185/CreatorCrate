# Agent Instructions

<!-- lean-ctx -->
## lean-ctx

lean-ctx is active — the MCP tools replace native equivalents.
Full rules: LEAN-CTX.md (open on demand — do not auto-load).
<!-- /lean-ctx -->

## Mandatory LeanCTX usage

Use LeanCTX by default for repository work.

- Use `lean-ctx_ctx_compose` first when understanding unfamiliar code.
- Use `lean-ctx_ctx_read` instead of native file reads.
- Use `lean-ctx_ctx_search` instead of native grep/search.
- Use `lean-ctx_ctx_shell` instead of native shell commands when available.
- Use `lean-ctx_ctx_callgraph` only after CodeGraph has identified the specific symbol or file area.
- Never run callgraph analysis against the entire repository.
- If callgraph times out, use CodeGraph for relationship discovery instead.
- Use `lean-ctx_ctx_expand` only when compressed output omitted required details.
- Use native tools only when the corresponding `lean-ctx_*` tool is unavailable or fails.
- Avoid full-file mode unless exact complete contents are required.
- Use `lean-ctx_ctx_search` only after CodeGraph has narrowed the relevant scope.
- Scope LeanCTX searches to the smallest relevant file or directory and keep result limits small.
- Do not use `lean-ctx_ctx_search` for broad whole-repository discovery.
- If a LeanCTX search times out, do not repeat the same search; narrow the path or return to CodeGraph.
- Do not use `lean-ctx_ctx_shell` with inline-code flags such as `node -e`, `python -c`, or `powershell -Command`.
- Use `lean-ctx_ctx_execute` for inline or multi-line scripts.
- When `ctx_execute` is unsuitable, write a temporary script file in the project, run it with `lean-ctx_ctx_shell`, and delete it afterward.
- Do not retry commands that LeanCTX marks as permanently blocked; change the execution method.

## Mandatory CodeGraph usage

Use CodeGraph by default for structural repository analysis when its index is available.

- Use CodeGraph before broad file scanning to identify relevant files, symbols, imports, callers, callees, and dependency paths.
- Use CodeGraph for architecture discovery, impact analysis, dead-code investigation, and tracing behavior across files.
- Prefer the `codegraph_explore` MCP tool when available.
- Use LeanCTX after CodeGraph to read only the files and ranges that CodeGraph identifies as relevant.
- Do not use CodeGraph as a substitute for exact source inspection; verify implementation details with `ctx_read`.
- If the CodeGraph index is missing, empty, or stale, report that clearly and fall back to LeanCTX tools.
- Re-check affected callers, callees, and dependency paths with CodeGraph before finalizing non-trivial changes.
- Do not fall back to broad LeanCTX repository searches when CodeGraph is available.
- If CodeGraph returns too much data, narrow by symbol, path, or relationship before reading source files.
