import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable } from "../security/policy.js";
import { recordBestEffort } from "../utils/audit.js";
import { ToolError } from "../utils/errors.js";
import { assertTextSize, atomicWriteFile, readTextFile, sha256, versionConflict } from "../utils/files.js";
import { withPathLock } from "../utils/lock.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

/** Counts occurrences including overlapping ones (conservative: ambiguity is rejected). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

export async function strReplaceTool(
  ctx: ToolContext,
  args: { path: string; old_str: string; new_str: string; if_version?: string | undefined },
) {
  if (args.old_str === args.new_str) throw new ToolError("NO_CHANGE", "old_str and new_str are identical.");
  const abs = await ctx.sandbox.resolve(args.path);
  assertWritable(ctx.sandbox, abs);
  const rel = ctx.sandbox.toRelative(abs);

  const result = await withPathLock(abs, async () => {
    const file = await readTextFile(abs);
    if (args.if_version !== undefined && args.if_version !== file.version) throw versionConflict(file.version);

    const count = countOccurrences(file.text, args.old_str);
    if (count === 0) throw new ToolError("NO_MATCH", "old_str was not found in the file. Re-read the file and copy the text exactly.");
    if (count > 1) {
      throw new ToolError("AMBIGUOUS_MATCH", `old_str matches ${count} locations. Include more surrounding text so it matches exactly once.`);
    }

    const idx = file.text.indexOf(args.old_str);
    // Slice instead of String.replace so '$&' etc. in new_str are inserted literally.
    const updated = file.text.slice(0, idx) + args.new_str + file.text.slice(idx + args.old_str.length);
    assertTextSize(updated);
    await atomicWriteFile(abs, updated);
    return {
      path: rel,
      replaced: 1,
      line: file.text.slice(0, idx).split("\n").length,
      bytes: Buffer.byteLength(updated, "utf8"),
      previous_version: file.version,
      version: sha256(updated),
    };
  });

  await recordBestEffort(ctx.audit, {
    tool: "str_replace",
    action: "edit",
    path: rel,
    detail: { previous_version: result.previous_version, version: result.version },
  });
  return result;
}

export function registerStrReplace(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "str_replace",
    {
      title: "Replace text in file",
      description:
        "Replace exactly ONE occurrence of old_str with new_str in a UTF-8 text file. old_str must match exactly once " +
        "(including whitespace and line endings); 0 matches or more than 1 match is an error and nothing is changed. " +
        "Optionally pass if_version (sha256 from read_file) to fail if the file changed. Returns the line number of the " +
        "edit and the new version. Fails for missing/binary/oversized files, paths outside the workspace, and anything inside .git.",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("File path relative to the workspace root."),
        old_str: z.string().min(1).max(100_000).describe("Exact text to find; must occur exactly once."),
        new_str: z.string().max(100_000).describe("Replacement text (may be empty to delete old_str)."),
        if_version: z
          .string()
          .regex(/^[a-f0-9]{64}$/, "must be a 64-character sha256 hex version")
          .optional()
          .describe("Fail unless the file's current version equals this."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await strReplaceTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
