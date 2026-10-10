import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/createServer.js";

let tmp: string;
let workspace: string;
let outside: string;
let client: Client;

async function call(args: Record<string, unknown>) {
  const res = await client.callTool({ name: "list_files", arguments: args });
  const content = res.content as { type: string; text: string }[];
  return { isError: res.isError === true, text: content[0]?.text ?? "" };
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfs-"));
  workspace = path.join(tmp, "ws");
  outside = path.join(tmp, "outside");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, "a.txt"), "hello");
  await fs.writeFile(path.join(workspace, "src", "b.ts"), "export {}");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");

  const server = await createServer(workspace);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterAll(async () => {
  await client.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("list_files", () => {
  it("is advertised by the server", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_files");
  });

  it("lists the workspace root", async () => {
    const r = await call({});
    expect(r.isError).toBe(false);
    const data = JSON.parse(r.text);
    const paths = data.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(["a.txt", "src"]);
  });

  it("lists recursively with workspace-relative paths", async () => {
    const r = await call({ recursive: true });
    const paths = JSON.parse(r.text).entries.map((e: { path: string }) => e.path);
    expect(paths).toContain("src/b.ts");
  });

  it("honours max_entries and reports truncation", async () => {
    const r = await call({ recursive: true, max_entries: 1 });
    const data = JSON.parse(r.text);
    expect(data.entries).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  it("rejects invalid input via the schema", async () => {
    await expect(client.callTool({ name: "list_files", arguments: { max_entries: 0 } })).resolves.toMatchObject({
      isError: true,
    });
  });

  it("returns a clean error for a missing path", async () => {
    const r = await call({ path: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Path not found.");
  });

  it("rejects ../ traversal", async () => {
    const r = await call({ path: "../outside" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("secret");
  });

  it("rejects absolute paths", async () => {
    const r = await call({ path: outside });
    expect(r.isError).toBe(true);
  });

  it("rejects a symlink that points outside the workspace", async (ctx) => {
    try {
      await fs.symlink(outside, path.join(workspace, "link"), "dir");
    } catch {
      ctx.skip(); // symlinks may need admin rights on Windows
    }
    const r = await call({ path: "link" });
    expect(r.isError).toBe(true);
  });
});
