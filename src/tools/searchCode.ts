import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_FILE_BYTES, looksBinary } from "../utils/files.js";
import { makeGlobMatcher } from "../utils/glob.js";
import { walk, type WalkState } from "../utils/walk.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

const MAX_SCAN_BYTES = 50 * 1024 * 1024;
const MAX_LINE_CHARS = 300;

interface Match {
  path: string;
  line: number;
  text: string;
}

export async function searchCodeTool(
  ctx: ToolContext,
  args: { query: string; path: string; glob?: string | undefined; case_sensitive: boolean; max_results: number },
) {
  const start = await ctx.sandbox.resolve(args.path);
  const st = await fs.stat(start);
  const globMatch = args.glob ? makeGlobMatcher(args.glob) : null;
  const needle = args.case_sensitive ? args.query : args.query.toLowerCase();

  const files: { abs: string; rel: string }[] = [];
  const state: WalkState = { visited: 0, limitHit: false };

  const matches: Match[] = [];
  let truncated = false;
  let filesScanned = 0;
  let bytesScanned = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;

  async function scan(abs: string, rel: string): Promise<boolean> {
    // returns false when scanning should stop
    if (globMatch && !globMatch(rel)) return true;
    const fst = await fs.stat(abs);
    if (fst.size > MAX_FILE_BYTES) {
      skippedLarge++;
      return true;
    }
    if (bytesScanned + fst.size > MAX_SCAN_BYTES) {
      truncated = true;
      return false;
    }
    const buf = await fs.readFile(abs);
    bytesScanned += buf.length;
    if (looksBinary(buf)) {
      skippedBinary++;
      return true;
    }
    filesScanned++;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const hay = args.case_sensitive ? line : line.toLowerCase();
      if (!hay.includes(needle)) continue;
      if (matches.length >= args.max_results) {
        truncated = true;
        return false;
      }
      matches.push({
        path: rel,
        line: i + 1,
        text: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line,
      });
    }
    return true;
  }

  if (st.isFile()) {
    files.push({ abs: start, rel: ctx.sandbox.toRelative(start) });
    for (const f of files) if (!(await scan(f.abs, f.rel))) break;
  } else {
    for await (const entry of walk(ctx.sandbox, start, { maxDepth: 20, maxVisited: 5_000 }, state)) {
      if (entry.type !== "file") continue;
      if (!(await scan(entry.abs, entry.rel))) break;
    }
  }

  return {
    matches,
    files_scanned: filesScanned,
    skipped: { binary: skippedBinary, too_large: skippedLarge },
    truncated: truncated || state.limitHit,
  };
}

export function registerSearchCode(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_code",
    {
      title: "Search file contents",
      description:
        "Search text files for a LITERAL string (not a regex) and return matching lines with workspace-relative path and " +
        "1-based line number. Read-only. Case-insensitive unless case_sensitive=true. Optionally restrict files with a glob " +
        "(same rules as search_files). Skips binary files, files over 1 MiB, .git and node_modules; symbolic links are not " +
        "followed. Output is bounded: max_results matches, lines cut at 300 characters, 5,000 files / 50 MiB scanned; " +
        "'truncated' tells you if any cap was hit.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Literal text to look for."),
        path: z.string().max(1024).default(".").describe("File or directory to search, relative to the workspace root."),
        glob: z.string().min(1).max(200).optional().describe("Only search files matching this glob, e.g. '*.ts'."),
        case_sensitive: z.boolean().default(false).describe("Match case exactly."),
        max_results: z.number().int().min(1).max(200).default(50).describe("Maximum matching lines to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await searchCodeTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
