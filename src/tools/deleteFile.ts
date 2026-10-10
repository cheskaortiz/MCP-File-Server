import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertDeletable } from "../security/policy.js";
import { ToolError } from "../utils/errors.js";
import { MAX_FILE_BYTES, readVersion, versionConflict } from "../utils/files.js";
import { withPathLock } from "../utils/lock.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

export async function deleteFileTool(ctx: ToolContext, args: { path: string; confirm: true; if_version?: string | undefined }) {
  const abs = await ctx.sandbox.resolve(args.path);
  assertDeletable(ctx.sandbox, abs);
  const rel = ctx.sandbox.toRelative(abs);

  return withPathLock(abs, async () => {
    let st: Stats;
    try {
      st = await fs.stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ToolError("NOT_FOUND", "Path not found.");
      throw err;
    }
    if (!st.isFile()) throw new ToolError("NOT_A_FILE", "delete_file only deletes regular files, not directories.");

    const version = st.size <= MAX_FILE_BYTES ? await readVersion(abs, st.size) : null;
    if (args.if_version !== undefined && args.if_version !== version) throw versionConflict(version);

    // Fail closed: if we cannot record the deletion, we do not delete.
    try {
      await ctx.audit.record({ tool: "delete_file", action: "delete", path: rel, detail: { bytes: st.size, version } });
    } catch (err) {
      console.error("Audit log write failed; refusing deletion:", err);
      throw new ToolError("AUDIT_FAILED", "Deletion refused: the audit log is unavailable.");
    }

    await fs.unlink(abs);
    return { path: rel, deleted: true, bytes: st.size, version };
  });
}

export function registerDeleteFile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description:
        "DESTRUCTIVE: permanently delete ONE regular file (never directories). Requires confirm=true. Optionally pass " +
        "if_version (sha256 from read_file) to delete only if the file is unchanged. Every deletion is written to an audit log " +
        "first; if the log is unavailable the deletion is refused. Handoff files (PROJECT_STATE.md, PLAN_LOG.md, " +
        "CHECKPOINTS.md, DECISIONS.md) and anything inside .git cannot be deleted. Fails for missing paths, directories, " +
        "version conflicts, and paths outside the workspace.",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("File path relative to the workspace root."),
        confirm: z.literal(true).describe("Must be exactly true to acknowledge that deletion is permanent."),
        if_version: z
          .string()
          .regex(/^[a-f0-9]{64}$/, "must be a 64-character sha256 hex version")
          .optional()
          .describe("Delete only if the file's current version equals this."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await deleteFileTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
