import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("write_file", () => {
  it("creates a new file, including missing parent directories", async () => {
    const r = await h.call("write_file", { path: "notes/deep/a.txt", content: "hi" });
    expect(r.isError).toBe(false);
    const data = r.json<{ created: boolean; version: string; bytes: number }>();
    expect(data.created).toBe(true);
    expect(data.bytes).toBe(2);
    expect(data.version).toBe(sha("hi"));
    expect(await fs.readFile(h.ws("notes", "deep", "a.txt"), "utf8")).toBe("hi");
  });

  it("overwrites an existing file and leaves no temp files behind", async () => {
    await fs.writeFile(h.ws("a.txt"), "old");
    const r = await h.call("write_file", { path: "a.txt", content: "new" });
    expect(r.json<{ created: boolean }>().created).toBe(false);
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("new");
    expect(await fs.readdir(h.workspace)).toEqual(["a.txt"]);
  });

  it("accepts a matching if_version", async () => {
    await fs.writeFile(h.ws("a.txt"), "v1");
    const r = await h.call("write_file", { path: "a.txt", content: "v2", if_version: sha("v1") });
    expect(r.isError).toBe(false);
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("v2");
  });

  it("rejects a stale if_version and leaves the file unchanged", async () => {
    await fs.writeFile(h.ws("a.txt"), "v1");
    const r = await h.call("write_file", { path: "a.txt", content: "v2", if_version: sha("something else") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Version conflict");
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("v1");
  });

  it("if_version='new' creates only when the file does not exist", async () => {
    const first = await h.call("write_file", { path: "n.txt", content: "1", if_version: "new" });
    expect(first.isError).toBe(false);
    const second = await h.call("write_file", { path: "n.txt", content: "2", if_version: "new" });
    expect(second.isError).toBe(true);
    expect(await fs.readFile(h.ws("n.txt"), "utf8")).toBe("1");
  });

  it("rejects a hash if_version when the file does not exist", async () => {
    const r = await h.call("write_file", { path: "ghost.txt", content: "x", if_version: sha("x") });
    expect(r.isError).toBe(true);
    await expect(fs.access(h.ws("ghost.txt"))).rejects.toThrow();
  });

  it("lets exactly one of two concurrent writers with the same if_version win", async () => {
    await fs.writeFile(h.ws("race.txt"), "base");
    const version = sha("base");
    const [a, b] = await Promise.all([
      h.call("write_file", { path: "race.txt", content: "from A", if_version: version }),
      h.call("write_file", { path: "race.txt", content: "from B", if_version: version }),
    ]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    const final = await fs.readFile(h.ws("race.txt"), "utf8");
    expect(final).toBe(a.isError ? "from B" : "from A");
  });

  it("rejects content over 1 MiB", async () => {
    const r = await h.call("write_file", { path: "big.txt", content: "a".repeat(1_048_577) });
    expect(r.isError).toBe(true);
    await expect(fs.access(h.ws("big.txt"))).rejects.toThrow();
  });

  it("counts bytes, not characters, for the size limit", async () => {
    // 400,000 euro signs = 400,000 chars but 1,200,000 bytes
    const r = await h.call("write_file", { path: "euro.txt", content: "€".repeat(400_000) });
    expect(r.isError).toBe(true);
  });

  it("refuses to overwrite a directory", async () => {
    await fs.mkdir(h.ws("dir"));
    const r = await h.call("write_file", { path: "dir", content: "x" });
    expect(r.isError).toBe(true);
  });

  it("refuses to modify the workspace root", async () => {
    const r = await h.call("write_file", { path: ".", content: "x" });
    expect(r.isError).toBe(true);
  });

  it("refuses to write inside .git", async () => {
    await fs.mkdir(h.ws(".git"));
    const r = await h.call("write_file", { path: ".git/config", content: "[core]\nfsmonitor = evil" });
    expect(r.isError).toBe(true);
    await expect(fs.access(h.ws(".git", "config"))).rejects.toThrow();
  });

  it("rejects a malformed if_version (schema)", async () => {
    const r = await h.call("write_file", { path: "a.txt", content: "x", if_version: "nope" });
    expect(r.isError).toBe(true);
  });

  it("records successful writes in the audit log without file contents", async () => {
    await h.call("write_file", { path: "audit.txt", content: "SECRET-CONTENT" });
    const log = await fs.readFile(h.auditLogPath, "utf8");
    expect(log).toContain('"tool":"write_file"');
    expect(log).toContain("audit.txt");
    expect(log).not.toContain("SECRET-CONTENT");
  });
});
