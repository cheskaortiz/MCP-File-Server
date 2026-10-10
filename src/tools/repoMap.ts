import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../utils/errors.js";
import { walk, type WalkState } from "../utils/walk.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

export async function repoMapTool(ctx: ToolContext, args: { path: string; max_depth: number; max_entries: number }) {
  const start = await ctx.sandbox.resolve(args.path);
  if (!(await fs.stat(start)).isDirectory()) throw new ToolError("NOT_A_DIRECTORY", "repo_map needs a directory.");

  const state: WalkState = { visited: 0, limitHit: false };
  const lines: string[] = [];
  const byExtension: Record<string, number> = {};
  let files = 0;
  let directories = 0;

  for await (const entry of walk(ctx.sandbox, start, { maxDepth: args.max_depth, maxVisited: args.max_entries }, state)) {
    const indent = "  ".repeat(entry.depth - 1);
    const name = path.basename(entry.abs);
    if (entry.type === "directory") {
      directories++;
      lines.push(`${indent}${name}/`);
    } else {
      files++;
      const ext = path.extname(name).toLowerCase() || "(none)";
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
      const size = (await fs.stat(entry.abs)).size;
      lines.push(`${indent}${name} (${size} B)`);
    }
  }

  return {
    root: ctx.sandbox.toRelative(start),
    tree: lines.join("\n"),
    files,
    directories,
    by_extension: byExtension,
    truncated: state.limitHit,
  };
}

export function registerRepoMap(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "repo_map",
    {
      title: "Repository map",
      description:
        "Return a compact indented tree of a directory (directories first, files with sizes) plus file counts by extension. " +
        "Read-only. Use it once at the start of a session to learn the project layout instead of many list_files calls. " +
        "Skips .git and node_modules; symbolic links are not followed. Bounded by max_depth (1 = top level only) and " +
        "max_entries; 'truncated' is true if entries were left out.",
      inputSchema: {
        path: z.string().max(1024).default(".").describe("Directory relative to the workspace root."),
        max_depth: z.number().int().min(1).max(6).default(3).describe("How many directory levels to show."),
        max_entries: z.number().int().min(1).max(1000).default(300).describe("Maximum entries in the tree."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await repoMapTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
