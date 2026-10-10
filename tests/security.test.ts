import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, trySymlink, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const EXPECTED_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "str_replace",
  "delete_file",
  "search_files",
  "search_code",
  "repo_map",
  "git_status",
];

describe("tool catalog", () => {
  it("exposes at least eight tools, including all required ones", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of EXPECTED_TOOLS) expect(names).toContain(name);
  });

  it("gives every tool a description and a strict object schema", async () => {
    const { tools } = await h.client.listTools();
    for (const t of tools) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });
});

/** Each case sends a hostile `path` to a tool and says what must NOT happen. */
const pathTools: { tool: string; args: (p: string) => Record<string, unknown> }[] = [
  { tool: "list_files", args: (p) => ({ path: p }) },
  { tool: "read_file", args: (p) => ({ path: p }) },
  { tool: "write_file", args: (p) => ({ path: p, content: "PWNED" }) },
  { tool: "str_replace", args: (p) => ({ path: p, old_str: "TOP-SECRET", new_str: "PWNED" }) },
  { tool: "delete_file", args: (p) => ({ path: p, confirm: true }) },
  { tool: "search_files", args: (p) => ({ pattern: "*", path: p }) },
  { tool: "search_code", args: (p) => ({ query: "SECRET", path: p }) },
  { tool: "repo_map", args: (p) => ({ path: p }) },
];

describe("path traversal and absolute paths are rejected by every tool", () => {
  const hostile = ["../outside/secret.txt", "../outside", "a/../../outside/secret.txt", "..", "../"];

  for (const { tool, args } of pathTools) {
    it(`${tool} rejects ../ style paths`, async () => {
      for (const p of hostile) {
        const r = await h.call(tool, args(p));
        expect(r.isError, `${tool} ${p}`).toBe(true);
        expect(r.text, `${tool} ${p}`).not.toContain("TOP-SECRET");
      }
      expect(await fs.readFile(h.out("secret.txt"), "utf8")).toBe("TOP-SECRET");
    });

    it(`${tool} rejects absolute paths`, async () => {
      const r = await h.call(tool, args(h.out("secret.txt")));
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("TOP-SECRET");
      expect(await fs.readFile(h.out("secret.txt"), "utf8")).toBe("TOP-SECRET");
    });
  }

  it("rejects Windows-style absolute and UNC paths on any OS", async () => {
    for (const p of ["C:\\Windows\\win.ini", "\\\\server\\share\\x", "/etc/passwd"]) {
      expect((await h.call("read_file", { path: p })).isError, p).toBe(true);
    }
  });

  it("rejects null bytes", async () => {
    expect((await h.call("read_file", { path: "a.txt\0.png" })).isError).toBe(true);
    expect((await h.call("write_file", { path: "a\0b.txt", content: "x" })).isError).toBe(true);
  });

  it("does not let a sibling directory with a shared prefix pass a string-prefix check", async () => {
    // ws = <tmp>/ws ; sibling = <tmp>/ws-evil would pass a naive startsWith(root) test
    await fs.mkdir(h.tmp + "/ws-evil");
    await fs.writeFile(h.tmp + "/ws-evil/loot.txt", "LOOT");
    const r = await h.call("read_file", { path: "../ws-evil/loot.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("LOOT");
  });

  it("still allows harmless '..' that stays inside the workspace", async () => {
    await fs.mkdir(h.ws("a"));
    await fs.writeFile(h.ws("b.txt"), "inside");
    const r = await h.call("read_file", { path: "a/../b.txt" });
    expect(r.isError).toBe(false);
    expect(r.json<{ content: string }>().content).toBe("inside");
  });

  it("never leaks host paths or stack traces in error messages", async () => {
    const attempts = [
      await h.call("read_file", { path: "../outside/secret.txt" }),
      await h.call("read_file", { path: "missing.txt" }),
      await h.call("write_file", { path: "../x", content: "x" }),
      await h.call("delete_file", { path: "missing.txt", confirm: true }),
    ];
    for (const r of attempts) {
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(h.tmp);
      expect(r.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
    }
  });
});

describe("symbolic link escapes", () => {
  it("blocks every tool from following a directory symlink out of the workspace", async () => {
    if (!(await trySymlink(h.outside, h.ws("link"), "dir"))) return; // OS forbids symlinks
    for (const { tool, args } of pathTools) {
      const r = await h.call(tool, args("link"));
      expect(r.isError, `${tool} link`).toBe(true);
    }
    const viaLink = [
      await h.call("read_file", { path: "link/secret.txt" }),
      await h.call("write_file", { path: "link/new.txt", content: "PWNED" }),
      await h.call("str_replace", { path: "link/secret.txt", old_str: "TOP-SECRET", new_str: "PWNED" }),
      await h.call("delete_file", { path: "link/secret.txt", confirm: true }),
    ];
    for (const r of viaLink) expect(r.isError).toBe(true);
    expect(await fs.readFile(h.out("secret.txt"), "utf8")).toBe("TOP-SECRET");
    await expect(fs.access(h.out("new.txt"))).rejects.toThrow();
  });

  it("blocks a file symlink that points outside", async () => {
    if (!(await trySymlink(h.out("secret.txt"), h.ws("flink"), "file"))) return;
    expect((await h.call("read_file", { path: "flink" })).isError).toBe(true);
    expect((await h.call("write_file", { path: "flink", content: "PWNED" })).isError).toBe(true);
    expect((await h.call("delete_file", { path: "flink", confirm: true })).isError).toBe(true);
    expect(await fs.readFile(h.out("secret.txt"), "utf8")).toBe("TOP-SECRET");
  });

  it("blocks creating a file through a dangling symlink that points outside", async () => {
    if (!(await trySymlink(h.out("does-not-exist.txt"), h.ws("dangling"), "file"))) return;
    const r = await h.call("write_file", { path: "dangling", content: "PWNED" });
    expect(r.isError).toBe(true);
    await expect(fs.access(h.out("does-not-exist.txt"))).rejects.toThrow();
  });

  it("does not follow symlinks while listing, searching or mapping", async () => {
    if (!(await trySymlink(h.outside, h.ws("link"), "dir"))) return;
    await fs.writeFile(h.ws("real.txt"), "SECRET inside");

    const listed = await h.call("list_files", { recursive: true });
    const entries = listed.json<{ entries: { path: string; type: string }[] }>().entries;
    expect(entries.find((e) => e.path === "link")?.type).toBe("symlink");
    expect(entries.some((e) => e.path.startsWith("link/"))).toBe(false);

    const found = await h.call("search_code", { query: "TOP-SECRET" });
    expect(found.json<{ matches: unknown[] }>().matches).toHaveLength(0);

    const files = await h.call("search_files", { pattern: "secret.txt" });
    expect(files.json<{ matches: unknown[] }>().matches).toHaveLength(0);

    const map = await h.call("repo_map", {});
    expect(map.json<{ tree: string }>().tree).not.toContain("secret.txt");
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await fs.writeFile(h.ws("target.txt"), "inside");
    if (!(await trySymlink(h.ws("target.txt"), h.ws("alias"), "file"))) return;
    const r = await h.call("read_file", { path: "alias" });
    expect(r.isError).toBe(false);
  });
});

describe("destructive operations", () => {
  it("never deletes anything outside the workspace even with confirm=true", async () => {
    await h.call("delete_file", { path: "../outside/secret.txt", confirm: true });
    await h.call("delete_file", { path: h.out("secret.txt"), confirm: true });
    expect(await fs.readFile(h.out("secret.txt"), "utf8")).toBe("TOP-SECRET");
  });

  it("cannot delete the workspace root or write to it", async () => {
    expect((await h.call("delete_file", { path: ".", confirm: true })).isError).toBe(true);
    expect((await h.call("write_file", { path: ".", content: "x" })).isError).toBe(true);
    await expect(fs.access(h.workspace)).resolves.toBeUndefined();
  });
});
