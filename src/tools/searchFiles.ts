import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../utils/errors.js";
import { makeGlobMatcher } from "../utils/glob.js";
import { walk, type WalkState } from "../utils/walk.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

export async function searchFilesTool(ctx: ToolContext, args: { pattern: string; path: string; max_results: number }) {
  const start = await ctx.sandbox.resolve(args.path);
  if (!(await fs.stat(start)).isDirectory()) throw new ToolError("NOT_A_DIRECTORY", "Search path must be a directory.");

  const matches_ = makeGlobMatcher(args.pattern);
  const state: WalkState = { visited: 0, limitHit: false };
  const matches: { path: string; type: "file" | "directory" }[] = [];
  let truncated = false;

  for await (const entry of walk(ctx.sandbox, start, { maxDepth: 20, maxVisited: 10_000 }, state)) {
    if (!matches_(entry.rel)) continue;
    if (matches.length >= args.max_results) {
      truncated = true;
      break;
    }
    matches.push({ path: entry.rel, type: entry.type });
  }
  return { matches, truncated: truncated || state.limitHit };
}

export function registerSearchFiles(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_files",
    {
      title: "Search files by name",
      description:
        "Find files and directories whose NAME or path matches a glob. Read-only. Supports *, ** and ? (no braces); " +
        "case-insensitive. A pattern without '/' (e.g. '*.ts') matches the file name; a pattern with '/' (e.g. 'src/**/*.ts') " +
        "matches the workspace-relative path. Skips .git and node_modules; symbolic links are not followed. " +
        "Results are capped by max_results and the scan is capped at 10,000 entries; 'truncated' tells you if a cap was hit.",
      inputSchema: {
        pattern: z.string().min(1).max(200).describe("Glob such as '*.md' or 'src/**/*.ts'."),
        path: z.string().max(1024).default(".").describe("Directory to search, relative to the workspace root."),
        max_results: z.number().int().min(1).max(500).default(100).describe("Maximum matches to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await searchFilesTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
