import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp, type HttpAppOptions } from "../src/http/httpApp.js";

const TOKEN = "test-token-" + "a1b2c3d4".repeat(6);

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-test", version: "0.0.0" } },
};

interface Running {
  base: string;
  port: number;
  close(): Promise<void>;
}

async function startApp(options: HttpAppOptions): Promise<Running> {
  const server = createHttpApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** node:http lets us set the Host header, which fetch forbids. */
function rawPost(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let tmp: string;
let workspace: string;
let app: Running;
const logs: string[] = [];

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${app.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfs-http-"));
  workspace = path.join(tmp, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "hello.txt"), "hello from disk");
  app = await startApp({
    workspaceRoot: workspace,
    auditLogPath: path.join(tmp, "logs", "audit.log"),
    authToken: TOKEN,
    maxBodyBytes: 4096,
    log: (line) => logs.push(line),
  });
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("HTTP authentication", () => {
  it("rejects /mcp without a token (401 + WWW-Authenticate)", async () => {
    const res = await post(INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("rejects an invalid token, including same-length and near-miss tokens", async () => {
    for (const bad of ["wrong", "x".repeat(TOKEN.length), TOKEN + "x", TOKEN.slice(0, -1)]) {
      const res = await post(INITIALIZE, { authorization: `Bearer ${bad}` });
      expect(res.status, bad).toBe(401);
    }
  });

  it("rejects a non-Bearer scheme and a bare token", async () => {
    expect((await post(INITIALIZE, { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post(INITIALIZE, { authorization: TOKEN })).status).toBe(401);
  });

  it("does not accept the token in the query string", async () => {
    const res = await fetch(`${app.base}/mcp?token=${TOKEN}&access_token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
  });

  it("never runs a tool for an unauthenticated request", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: "pwned.txt", content: "PWNED" } },
    });
    expect(res.status).toBe(401);
    await expect(fs.access(path.join(workspace, "pwned.txt"))).rejects.toThrow();
  });

  it("checks authentication before routing, so unknown paths and GET also get 401", async () => {
    expect((await fetch(`${app.base}/mcp`)).status).toBe(401);
    expect((await fetch(`${app.base}/anything`)).status).toBe(401);
  });

  it("accepts a valid token (initialize succeeds)", async () => {
    const res = await post(INITIALIZE, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("mcp-file-server");
  });

  it("accepts a lower-case 'bearer' scheme", async () => {
    expect((await post(INITIALIZE, { authorization: `bearer ${TOKEN}` })).status).toBe(200);
  });
});

describe("HTTP routing and hardening", () => {
  it("serves an unauthenticated health check that reveals nothing else", async () => {
    const res = await fetch(`${app.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 405 for GET and DELETE on /mcp (stateless mode) when authenticated", async () => {
    expect((await fetch(`${app.base}/mcp`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${app.base}/mcp`, { method: "DELETE", headers: auth })).status).toBe(405);
  });

  it("returns 404 for unknown paths when authenticated", async () => {
    expect((await fetch(`${app.base}/other`, { headers: auth })).status).toBe(404);
  });

  it("returns 415 for a non-JSON content type", async () => {
    const res = await fetch(`${app.base}/mcp`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "hi" });
    expect(res.status).toBe(415);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await post("{not json", auth);
    expect(res.status).toBe(400);
  });

  it("returns 413 when the body exceeds the limit", async () => {
    const res = await post("x".repeat(5000), auth);
    expect(res.status).toBe(413);
  });

  it("sets no-store and nosniff headers on errors", async () => {
    const res = await post(INITIALIZE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("HTTP end-to-end with the official MCP client", () => {
  function newClient(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    return { client: new Client({ name: "e2e", version: "0.0.0" }), transport };
  }

  it("lists all 9 tools and calls a tool through the real sandbox", async () => {
    const { client, transport } = newClient(TOKEN);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(9);
      for (const name of ["list_files", "read_file", "write_file", "str_replace", "delete_file", "search_files", "search_code", "repo_map", "git_status"]) {
        expect(tools.map((t) => t.name)).toContain(name);
      }
      const res = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
      const text = (res.content as { text: string }[])[0]?.text ?? "";
      expect(res.isError).not.toBe(true);
      expect(JSON.parse(text).content).toBe("hello from disk");
    } finally {
      await client.close();
    }
  });

  it("keeps the sandbox: path traversal is still rejected over HTTP", async () => {
    const { client, transport } = newClient(TOKEN);
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("hands off PROJECT_STATE.md context between two separate client sessions", async () => {
    const a = newClient(TOKEN);
    const b = newClient(TOKEN);
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);
    try {
      const nextTask = "NEXT TASK: Add an integration test for project state handoff.";
      const write = await a.client.callTool({
        name: "write_file",
        arguments: { path: "PROJECT_STATE.md", content: `Project context from Session A.\n${nextTask}\n` },
      });
      expect(write.isError).not.toBe(true);
      const read = await b.client.callTool({ name: "read_file", arguments: { path: "PROJECT_STATE.md" } });
      expect(read.isError).not.toBe(true);
      expect(JSON.parse((read.content as { text: string }[])[0]?.text ?? "{}").content).toContain(nextTask);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("writes the audit log for destructive operations made over HTTP", async () => {
    const { client, transport } = newClient(TOKEN);
    await client.connect(transport);
    try {
      await client.callTool({ name: "write_file", arguments: { path: "temp.txt", content: "x" } });
      const del = await client.callTool({ name: "delete_file", arguments: { path: "temp.txt", confirm: true } });
      expect(del.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    const log = await fs.readFile(path.join(tmp, "logs", "audit.log"), "utf8");
    expect(log).toContain('"tool":"delete_file"');
  });

  it("refuses a client with a bad token", async () => {
    const { client, transport } = newClient("definitely-not-the-token-" + "z".repeat(20));
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});

describe("request logging", () => {
  it("logs method, path and status but never the token or headers", async () => {
    await post(INITIALIZE); // 401
    await post(INITIALIZE, auth); // 200
    await new Promise((r) => setTimeout(r, 100));
    const all = logs.join("\n");
    expect(all).toMatch(/POST \/mcp 401/);
    expect(all).toMatch(/POST \/mcp 200/);
    expect(all).not.toContain(TOKEN);
    expect(all.toLowerCase()).not.toContain("authorization");
  });

  it("does not log query strings", async () => {
    await fetch(`${app.base}/mcp?secret=hunter2`, { headers: auth });
    await new Promise((r) => setTimeout(r, 100));
    expect(logs.join("\n")).not.toContain("hunter2");
  });
});

describe("Host allow-list", () => {
  it("rejects unlisted Host headers even with a valid token, and accepts listed ones", async () => {
    const guarded = await startApp({ workspaceRoot: workspace, authToken: TOKEN, allowedHosts: ["mcp.example.com"], log: () => undefined });
    try {
      const headers = {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const body = JSON.stringify(INITIALIZE);
      expect((await rawPost(guarded.port, { ...headers, host: "evil.example" }, body)).status).toBe(403);
      expect((await rawPost(guarded.port, { ...headers, host: `127.0.0.1:${guarded.port}` }, body)).status).toBe(403);
      expect((await rawPost(guarded.port, { ...headers, host: "mcp.example.com" }, body)).status).toBe(200);
      expect((await rawPost(guarded.port, { ...headers, host: "MCP.example.com:8443" }, body)).status).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});
