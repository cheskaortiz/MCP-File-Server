import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/createServer.js";

export interface CallResult {
  isError: boolean;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

export interface HarnessOptions {
  /** Point the audit log at an unusable location (a path below a regular file). */
  breakAudit?: boolean;
}

/** A temp workspace, a sibling "outside" directory holding a secret, and a real MCP client. */
export async function createHarness(options: HarnessOptions = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfs-"));
  const workspace = path.join(tmp, "ws");
  const outside = path.join(tmp, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP-SECRET");

  let auditLogPath = path.join(tmp, "logs", "audit.log");
  if (options.breakAudit) {
    const blocker = path.join(tmp, "blocker");
    await fs.writeFile(blocker, "i am a file");
    auditLogPath = path.join(blocker, "audit.log");
  }

  const server = await createServer(workspace, { auditLogPath });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    let isError = false;
    let text = "";
    try {
      const res = await client.callTool({ name, arguments: args });
      isError = res.isError === true;
      const content = res.content as { type: string; text?: string }[];
      text = content[0]?.text ?? "";
    } catch (err) {
      // Some SDK versions throw on schema-validation failures instead of returning isError.
      isError = true;
      text = err instanceof Error ? err.message : String(err);
    }
    return { isError, text, json: <T = Record<string, unknown>>() => JSON.parse(text) as T };
  }

  const ws = (...parts: string[]) => path.join(workspace, ...parts);
  const out = (...parts: string[]) => path.join(outside, ...parts);

  async function close() {
    await client.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return { tmp, workspace, outside, auditLogPath, client, call, ws, out, close };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Returns false (instead of throwing) when the OS refuses to create symlinks. */
export async function trySymlink(target: string, linkPath: string, type: "file" | "dir"): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}
