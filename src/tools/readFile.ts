import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_FILE_BYTES, readTextFile } from "../utils/files.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

export async function readFileTool(ctx: ToolContext, args: { path: string; max_bytes: number }) {
  const abs = await ctx.sandbox.resolve(args.path);
  const file = await readTextFile(abs);
  const truncated = file.bytes > args.max_bytes;
  const content = truncated ? file.buf.subarray(0, args.max_bytes).toString("utf8") : file.text;
  return {
    path: ctx.sandbox.toRelative(abs),
    content,
    bytes: file.bytes,
    version: file.version,
    truncated,
  };
}

export function registerReadFile(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file from the workspace. Read-only. Returns content, size in bytes, and 'version' " +
        "(sha256 of the full file) which you can pass as if_version to write_file / str_replace / delete_file to detect " +
        "concurrent changes. If the file is bigger than max_bytes, content is cut off and truncated=true (version still " +
        "covers the whole file). Fails for missing files, directories, binary files, files over 1 MiB, and paths outside the workspace.",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("File path relative to the workspace root."),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_FILE_BYTES)
          .default(100_000)
          .describe("Maximum bytes of content to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await readFileTool(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
