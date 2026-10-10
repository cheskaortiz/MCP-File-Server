import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable } from "../security/policy.js";
import { recordBestEffort } from "../utils/audit.js";
import { ToolError } from "../utils/errors.js";
import {
  assertTextSize,
  atomicWriteFile,
  readVersion,
  sha256,
  statOrNull,
  versionConflict,
} from "../utils/files.js";
import { withPathLock } from "../utils/lock.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

export async function writeFileTool(ctx: ToolContext, args: { path: string; content: string; if_version?: string | undefined }) {
  assertTextSize(args.content);
  const abs = await ctx.sandbox.resolve(args.path);
  assertWritable(ctx.sandbox, abs);
  const rel = ctx.sandbox.toRelative(abs);

  const result = await withPathLock(abs, async () => {
    const st = await statOrNull(abs);
    if (st && !st.isFile()) throw new ToolError("NOT_A_FILE", "Target exists and is not a regular file.");

    if (args.if_version !== undefined) {
      if (args.if_version === "new") {
        if (st) throw new ToolError("VERSION_CONFLICT", "if_version is 'new' but the file already exists.");
      } else {
        if (!st) throw new ToolError("VERSION_CONFLICT", "if_version was supplied but the file does not exist.");
        const current = await readVersion(abs, st.size);
        if (current !== args.if_version) throw versionConflict(current);
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWriteFile(abs, args.content);
    return { path: rel, created: st === null, bytes: Buffer.byteLength(args.content, "utf8"), version: sha256(args.content) };
  });

  await recordBestEffort(ctx.audit, {
    tool: "write_file",
    action: result.created ? "create" : "overwrite",
    path: rel,
    detail: { bytes: result.bytes, version: result.version },
  });
  return result;
}

export function registerWriteFile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create a new UTF-8 text file or REPLACE an existing file's entire contents (max 1 MiB). Parent directories are " +
        "created automatically. The write is atomic (temp file + rename). For safe collaboration pass if_version: the sha256 " +
        "'version' from read_file to overwrite only if the file is unchanged, or the literal 'new' to create only if the file " +
        "does not exist. Prefer str_replace for small edits. Fails on version conflicts, directories, paths outside the " +
        "workspace, anything inside .git, and content over 1 MiB.",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("File path relative to the workspace root."),
        content: z.string().max(1_048_576).describe("Full new file content (UTF-8 text)."),
        if_version: z
          .string()
          .regex(/^(new|[a-f0-9]{64})$/, "must be 'new' or a 64-character sha256 hex version")
          .optional()
          .describe("Optimistic concurrency check: a version from read_file, or 'new'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await writeFileTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
