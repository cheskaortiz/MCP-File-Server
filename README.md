# MCP File Server (Agentic AI II midterm)

A sandboxed MCP file server in TypeScript. Agents read and modify files inside one workspace folder.

## Milestone status

| Milestone | Status |
|---|---|
| M1 Skeleton (`list_files`) | **Verified locally by the student**: `npm install`, `typecheck`, `test` (9/9), `build` passed; Inspector listed `list_files`, `path: "."` worked, `path: "../"` was rejected with `Path escapes the workspace.` |
| M2 Sandbox and core tools (9 tools) | **Implemented, NOT yet verified.** Code and tests were written in a sandbox without network access, so `npm install`, `npm test` and `npm run build` have not been run on it. Only a syntax scan was possible. Run the commands below and record the real results here. |
| M3 HTTP, auth, tunnel, PM2 | Not started |
| M4 Handoff files and protocol | Not started (`if_version` and handoff-file delete protection already exist from M2) |
| M5 Multi-session demo | Not started |

**M2 verification log (fill in after running locally):**
- `npm run typecheck`: _not run yet_
- `npm test`: _not run yet_ (record pass/fail counts)
- `npm run build`: _not run yet_
- Inspector smoke test of the new tools: _not run yet_

## Prerequisites
- Node.js >= 20.12 (`node -v`), npm
- Optional: `git` on PATH (only needed by `git_status` and its tests; those tests skip if git is missing)

## Setup
```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
npm run typecheck
npm test
npm run build
```

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACE_ROOT` | `./workspace` | The only folder agents can touch |
| `AUDIT_LOG_PATH` | `./logs/audit.log` | Append-only JSON-lines log of mutations. Keep it outside the workspace. |

## MCP Inspector
```bash
npm run build
npm run inspect
```
Connect, open Tools, and try each tool. Good first checks: `repo_map`, `write_file` then `read_file`, `str_replace`, and a `../` path on any tool.

## Tool catalog

| Tool | Kind | Inputs (all validated by Zod) | Notes |
|---|---|---|---|
| `list_files` | read | `path="."`, `recursive=false`, `max_entries=200 (1-1000)` | Symlinks listed, never followed |
| `read_file` | read | `path`, `max_bytes=100000 (1-1048576)` | Returns `version` (sha256). Text only, <= 1 MiB |
| `write_file` | write | `path`, `content` (<= 1 MiB), `if_version?` (`"new"` or sha256) | Atomic temp-file + rename. Creates parent dirs |
| `str_replace` | write | `path`, `old_str` (non-empty), `new_str`, `if_version?` | `old_str` must match exactly once, else nothing changes |
| `delete_file` | destructive | `path`, `confirm: true`, `if_version?` | Files only. Audit-logged first (fails closed). Handoff files and `.git` protected |
| `search_files` | read | `pattern` (glob), `path="."`, `max_results=100 (1-500)` | `*`, `**`, `?`; case-insensitive |
| `search_code` | read | `query` (literal), `path="."`, `glob?`, `case_sensitive=false`, `max_results=50 (1-200)` | Skips binary, > 1 MiB, `.git`, `node_modules` |
| `repo_map` | read | `path="."`, `max_depth=3 (1-6)`, `max_entries=300 (1-1000)` | Indented tree + counts by extension |
| `git_status` | read | none | Fixed read-only git command; only if the workspace root is itself a repo |

Every list-like result is bounded and reports `truncated` when a cap is hit.

## Sandbox rules
1. Every path argument goes through `sandbox.resolve()` (`src/security/sandbox.ts`). No tool touches the filesystem with a client path any other way.
2. Absolute paths (POSIX, Windows drive, UNC) and null bytes are rejected.
3. The path is normalized and must stay inside the root (checked with `path.relative`, not a string prefix).
4. Symlinks are resolved with `realpath` (on the deepest existing ancestor for new files) and the result must still be inside the real root. Dangling symlinks are refused.
5. Directory walks never follow symlinks.
6. Mutating tools additionally go through `src/security/policy.ts`: the root and anything inside `.git` cannot be modified (git config can execute commands), and the four handoff files cannot be deleted.
7. Errors shown to clients are short fixed messages: no stack traces, no host paths.

## Concurrency
`read_file` returns a sha256 `version`. Passing it as `if_version` makes `write_file`, `str_replace` and `delete_file` fail with a version conflict if the file changed. Within this one server process, a per-file lock makes check-then-write atomic, so two sessions racing with the same version cannot both win.

## Layout
```
src/config/    environment loading
src/security/  sandbox.ts (path gate), policy.ts (extra rules for mutations)
src/tools/     one file per tool, index.ts registers all, result.ts shared ok/fail
src/utils/     files, lock, audit, glob, walk, errors
src/createServer.ts  builds the McpServer (shared by stdio now, HTTP later, and tests)
src/server.ts        stdio entry point
tests/         Vitest tests using a real MCP client over an in-memory transport
workspace/     the sandbox root agents may touch
```

## Known limitations (honest list, to be expanded into the threat model)
- Check-then-use race (TOCTOU) between path validation and the filesystem call: a local process that can modify the workspace concurrently could swap a directory for a symlink. Agents only act through this server, so the window is only exploitable by another local process.
- `if_version` locking is per process; another process editing files directly is not coordinated.
- Operations on a symlink that stays inside the workspace act on its target.
- Case-insensitive filesystems: `.git` and handoff-file protection compare case-insensitively, but exotic Windows name tricks (trailing dots/spaces, 8.3 short names) are not specifically handled.
- Glob matching is hand-written and does not support braces or character classes.
- stdio only. No authentication yet (it is a local process); HTTP, token auth, tunnel and PM2 are Milestone 3.
- The audit log records metadata only (tool, path, size, hash), never file contents.
