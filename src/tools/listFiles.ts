import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Sandbox } from "../security/sandbox.js";
import { fail, ok } from "./result.js";

export interface FileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
}

export interface ListFilesResult {
  entries: FileEntry[];
  truncated: boolean;
}

/** Business logic (no MCP types) so it can be unit-tested directly. */
export async function listFiles(
  sandbox: Sandbox,
  args: { path: string; recursive: boolean; max_entries: number },
): Promise<ListFilesResult> {
  const start = await sandbox.resolve(args.path);
  const st = await fs.stat(start);
  if (!st.isDirectory()) {
    return { entries: [{ path: sandbox.toRelative(start), type: "file", size: st.size }], truncated: false };
  }

  const entries: FileEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= args.max_entries) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        entries.push({ path: sandbox.toRelative(abs), type: "symlink" }); // never followed
      } else if (item.isDirectory()) {
        entries.push({ path: sandbox.toRelative(abs), type: "directory" });
        if (args.recursive) await walk(abs);
      } else if (item.isFile()) {
        const s = await fs.stat(abs);
        entries.push({ path: sandbox.toRelative(abs), type: "file", size: s.size });
      } else {
        entries.push({ path: sandbox.toRelative(abs), type: "other" });
      }
      if (truncated) return;
    }
  }

  await walk(start);
  return { entries, truncated };
}

export function registerListFiles(server: McpServer, sandbox: Sandbox): void {
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files and directories inside the shared workspace. Read-only. " +
        "'path' is relative to the workspace root (default '.'). Absolute paths and '..' escapes are rejected. " +
        "Symbolic links are listed but never followed. Set recursive=true to descend into subdirectories. " +
        "Results are capped by max_entries; 'truncated' is true if the cap was hit. " +
        "Fails if the path does not exist or is outside the workspace.",
      inputSchema: {
        path: z.string().max(1024).default(".").describe("Directory (or file) relative to the workspace root."),
        recursive: z.boolean().default(false).describe("Descend into subdirectories."),
        max_entries: z.number().int().min(1).max(1000).default(200).describe("Maximum entries to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await listFiles(sandbox, args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
