# MCP File Server (Agentic AI II midterm)

**Status: Milestone 1 (skeleton) written. NOT yet built or tested by the author of these files** — they were
generated in a chat sandbox with no network, so `npm install`, `npm run build`, and `npm test` have not been run.
Run them yourself (below) and fix anything that fails before moving on.

## Prerequisites
- Node.js >= 20.12 (`node -v`)
- npm

## Setup
```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
npm run typecheck
npm test
npm run build
```

## Run and inspect (stdio, Milestone 1)
```bash
npm run build
npm run inspect
```
In the Inspector: Connect -> Tools -> List Tools -> `list_files` -> Run (try `path` = `.`, then `../`).

## Layout
- `src/config/` environment loading
- `src/security/sandbox.ts` the single path-validation gate (realpath-based, rejects absolute, `..`, symlink escapes)
- `src/tools/` one file per tool + `index.ts` registration
- `src/createServer.ts` builds the McpServer (reused by tests and, later, HTTP)
- `src/server.ts` stdio entry point
- `tests/` Vitest tests using an in-memory MCP client
- `workspace/` the sandbox root agents may touch

## Known limitations (so far)
- Only `list_files` exists. HTTP transport, auth, tunnel, PM2, handoff files are later milestones.
- Sandbox has a small check-then-use race (TOCTOU) window; to be discussed in the threat model.
