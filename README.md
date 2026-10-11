# MCP File Server (Agentic AI II midterm)

A sandboxed MCP file server built with TypeScript. Agents can read and modify files inside a designated workspace through the Model Context Protocol (MCP).

## Milestone Status

| Milestone | Status |
|---|---|
| M1 — Skeleton | Verified locally |
| M2 — Sandbox and core tools | Verified locally: 129 tests passed across 11 files; typecheck and build passed |
| M3 — HTTP transport and authentication | Verified locally: HTTP health check, bearer-token authentication, MCP initialization, and `tools/list` passed. PM2 operation, ngrok tunnel, and HTTP MCP Inspector tool testing verified |
| M4 — Handoff files and protocol | Not yet completed as a milestone. Handoff-file deletion protection already exists in M2 |
| M5 — Multi-session demonstration | Not yet completed |

### M2 and M3 Local Verification Log

- `npm.cmd run typecheck` — passed
- `npm.cmd test` — 129 tests passed across 11 files
- `npm.cmd run build` — passed
- `GET /healthz` — HTTP 200
- Unauthenticated `POST /mcp` — HTTP 401
- Authenticated MCP initialization — HTTP 200
- Authenticated `tools/list` — HTTP 200; 9 tools returned
- PM2 process management — verified; process online
- ngrok public tunnel — connected and HTTP MCP requests tested
- HTTP MCP Inspector — connected; tool tests passed
- `git_status` — verified clean repository and untracked-file detection

These results document local tests only. They do not establish that the server has been deployed publicly.

## Prerequisites

- Node.js 20.12 or later
- npm
- Git on PATH for Git-related functionality and tests

Check your installed versions:

```powershell
node -v
npm -v
git --version
```

## Setup

Install dependencies and prepare the local environment:

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

If `.env` already exists, do not overwrite it. Keep `.env` private and do not commit it to Git.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_ROOT` | `./workspace` | The root directory that agents may access |
| `AUDIT_LOG_PATH` | `./logs/audit.log` | Audit log for mutating operations; keep outside the workspace |
| `MCP_AUTH_TOKEN` | None | Bearer token required to access the HTTP MCP endpoint |
| `MCP_HOST` | `127.0.0.1` | HTTP server bind address |
| `MCP_PORT` | `3000` | HTTP server port |
| `MCP_ALLOWED_HOSTS` | Empty | Optional comma-separated allow-list of HTTP Host header values |

Relative paths are resolved according to the application's configuration. Configure a strong `MCP_AUTH_TOKEN` before starting the HTTP server.

## Running the Server

### Standard MCP Server (stdio)

Build the project and start the standard MCP server:

```powershell
npm.cmd run build
npm.cmd start
```

This mode is intended for MCP clients that launch the server as a local process using standard input and output.

### HTTP Server

The HTTP transport exposes the MCP endpoint at `/mcp` and a health endpoint at `/healthz`. Requests to `/mcp` require bearer-token authentication.

#### 1. Configure authentication

If you have not created `.env`, copy the example:

```powershell
Copy-Item .env.example .env
```

Generate a random token:

```powershell
npm.cmd run gen-token
```

Copy the generated token into `MCP_AUTH_TOKEN` in `.env`. Do not paste the actual token into this README, source code, or public repositories.

#### 2. Start in development mode

```powershell
npm.cmd run dev:http
```

#### 3. Start in production mode

Stop the development server first, then run:

```powershell
npm.cmd run build
npm.cmd run start:http
```

By default, the HTTP server listens on `http://127.0.0.1:3000`.

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health endpoint: `http://127.0.0.1:3000/healthz`

Check the health endpoint in a separate PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

The health check confirms that the HTTP service responds. It does not verify authentication or MCP tool functionality.

### HTTP Authentication

Send the configured token in the request header:

```text
Authorization: Bearer <your-token>
```

MCP clients must use compatible request headers. For the tested initialization request, the `Accept` header included both `application/json` and `text/event-stream`.

Keep the server bound to localhost during local development. Do not expose it publicly until authentication, Host header validation, tunnel configuration, and deployment security have been reviewed.

## MCP Inspector

The standard Inspector script launches the stdio server:

```powershell
npm.cmd run build
npm.cmd run inspect
```

Connect to the server, open the Tools section, and try the available tools.

Suggested checks:

- Run `repo_map`.
- Use `write_file` and then `read_file` on a test file.
- Test `str_replace`.
- Try a path such as `../` and verify that the sandbox rejects it.

For HTTP Inspector testing, connect to the running HTTP server using its configured endpoint and bearer-token authentication. The following tools have been tested successfully:

- `list_files` — listed workspace entries.
- `read_file` — read a sample Markdown file.
- `search_files` — found Markdown files by pattern.
- `search_code` — found matching text in a Markdown file.
- `repo_map` — returned the workspace tree and file counts.
- `git_status` — verified both a clean repository and untracked-file detection.

## Tool Catalog

All tool inputs are validated using Zod schemas.

| Tool | Category | Inputs | Notes |
|---|---|---|---|
| `list_files` | Read | `path="."`, `recursive=false`, `max_entries=200` (1–1000) | Lists entries without following symlinks |
| `read_file` | Read | `path`, `max_bytes=100000` (1–1048576) | Returns a SHA-256 version; text files up to 1 MiB |
| `write_file` | Write | `path`, `content` (up to 1 MiB), optional `if_version` | Supports `"new"` or a SHA-256 version; writes atomically |
| `str_replace` | Write | `path`, `old_str`, `new_str`, optional `if_version` | Requires `old_str` to match exactly once |
| `delete_file` | Destructive | `path`, `confirm: true`, optional `if_version` | Deletes files only; audit logging must succeed first |
| `search_files` | Read | `pattern`, `path="."`, `max_results=100` (1–500) | Supports `*`, `**`, and `?`; case-insensitive |
| `search_code` | Read | `query`, `path="."`, optional `glob`, `case_sensitive=false`, `max_results=50` (1–200) | Skips binary files, files over 1 MiB, `.git`, and `node_modules` |
| `repo_map` | Read | `path="."`, `max_depth=3` (1–6), `max_entries=300` (1–1000) | Returns an indented tree and extension counts |
| `git_status` | Read | None | Uses a fixed, read-only Git command when the workspace root is a Git repository |

List-like results are bounded. Results indicate when an output limit has been reached.

## Sandbox and Security Rules

1. All client-provided file paths pass through the sandbox resolver in `src/security/sandbox.ts`.
2. Absolute paths, Windows drive paths, UNC paths, and null bytes are rejected.
3. Paths are normalized and checked to ensure they remain inside the configured workspace.
4. Symlinks are resolved and checked against the real workspace root. Dangling symlinks are refused.
5. Directory traversal does not follow symlinks.
6. Mutating operations use additional rules in `src/security/policy.ts`. The workspace root and `.git` contents cannot be modified through the tools.
7. Handoff-file deletion protection is implemented in M2.
8. Client-facing errors use short messages and avoid exposing stack traces or host filesystem paths.
9. Mutating operations are recorded in an audit log. The audit log records metadata rather than file contents.

These protections reduce risk but do not eliminate every possible filesystem or deployment threat.

## Concurrency and Version Checks

`read_file` returns a SHA-256 `version`. Passing that value through `if_version` allows `write_file`, `str_replace`, and `delete_file` to detect whether a file has changed since it was read.

The server uses per-file locking within a single process for version-checked mutations. These locks do not coordinate with external processes that edit the same files directly.

## Project Layout

```text
src/
  config/       Environment and HTTP configuration
  security/     Sandbox and mutation policy
  tools/        MCP tool implementations and registration
  utils/        Shared file, lock, audit, glob, walk, and error utilities
  http/         HTTP application and authentication
  createServer.ts
  server.ts     Standard stdio entry point
  httpServer.ts HTTP entry point

tests/          Vitest tests
workspace/      Default sandbox workspace
```

## Known Limitations

- A local process that modifies the workspace concurrently may create a time-of-check/time-of-use (TOCTOU) race involving filesystem paths.
- Version checks and locks operate within the server process; they do not coordinate with external file editors.
- Operations on symlinks that remain inside the workspace can act on their targets.
- Some unusual Windows filesystem naming behaviors may not be fully covered.
- The custom glob implementation does not support every glob syntax, such as braces or character classes.
- The standard stdio mode and HTTP mode have different connection and authentication requirements.
- A bearer token alone does not make public deployment safe. Network exposure, Host header validation, tunnel settings, and process management require separate verification.
- Tunnel deployment, PM2 operation, and HTTP Inspector verification have not yet been confirmed.

## Development Commands

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run dev
npm.cmd run dev:http
```

Use `npm.cmd` in Windows PowerShell if the execution policy prevents running `npm.ps1` directly.

## Project Status

The local M2 test suite and the initial M3 HTTP authentication checks have passed. Remaining work includes completing and verifying deployment, finalizing the M4 handoff protocol, and conducting the M5 multi-session demonstration. Update this README when new checks have actually been completed.
