import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("delete_file", () => {
  it("deletes a file when confirm=true and writes an audit entry", async () => {
    h = await createHarness();
    await fs.writeFile(h.ws("gone.txt"), "bye");
    const r = await h.call("delete_file", { path: "gone.txt", confirm: true });
    expect(r.isError).toBe(false);
    expect(r.json<{ deleted: boolean }>().deleted).toBe(true);
    await expect(fs.access(h.ws("gone.txt"))).rejects.toThrow();

    const entry = JSON.parse((await fs.readFile(h.auditLogPath, "utf8")).trim().split("\n")[0] ?? "{}");
    expect(entry.tool).toBe("delete_file");
    expect(entry.path).toBe("gone.txt");
    expect(entry.detail.version).toBe(sha("bye"));
    expect(typeof entry.ts).toBe("string");
  });

  it("refuses without confirm=true and keeps the file", async () => {
    h = await createHarness();
    await fs.writeFile(h.ws("keep.txt"), "x");
    expect((await h.call("delete_file", { path: "keep.txt" })).isError).toBe(true);
    expect((await h.call("delete_file", { path: "keep.txt", confirm: false })).isError).toBe(true);
    expect((await h.call("delete_file", { path: "keep.txt", confirm: "yes" })).isError).toBe(true);
    await expect(fs.access(h.ws("keep.txt"))).resolves.toBeUndefined();
  });

  it("refuses to delete directories", async () => {
    h = await createHarness();
    await fs.mkdir(h.ws("dir"));
    await fs.writeFile(h.ws("dir", "f.txt"), "x");
    const r = await h.call("delete_file", { path: "dir", confirm: true });
    expect(r.isError).toBe(true);
    await expect(fs.access(h.ws("dir", "f.txt"))).resolves.toBeUndefined();
  });

  it("returns a clean error for a missing file", async () => {
    h = await createHarness();
    const r = await h.call("delete_file", { path: "nope.txt", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Path not found.");
  });

  it("honours if_version", async () => {
    h = await createHarness();
    await fs.writeFile(h.ws("v.txt"), "current");
    const stale = await h.call("delete_file", { path: "v.txt", confirm: true, if_version: sha("old") });
    expect(stale.isError).toBe(true);
    await expect(fs.access(h.ws("v.txt"))).resolves.toBeUndefined();
    const good = await h.call("delete_file", { path: "v.txt", confirm: true, if_version: sha("current") });
    expect(good.isError).toBe(false);
  });

  it("protects the handoff files (case-insensitively) and .git", async () => {
    h = await createHarness();
    for (const name of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md", "project_state.md"]) {
      await fs.writeFile(h.ws(name), "state");
      const r = await h.call("delete_file", { path: name, confirm: true });
      expect(r.isError, name).toBe(true);
      await expect(fs.access(h.ws(name))).resolves.toBeUndefined();
    }
    await fs.mkdir(h.ws(".git"));
    await fs.writeFile(h.ws(".git", "HEAD"), "ref");
    expect((await h.call("delete_file", { path: ".git/HEAD", confirm: true })).isError).toBe(true);
  });

  it("refuses to delete (fails closed) when the audit log is unavailable", async () => {
    h = await createHarness({ breakAudit: true });
    await fs.writeFile(h.ws("precious.txt"), "keep me");
    const r = await h.call("delete_file", { path: "precious.txt", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("audit");
    expect(await fs.readFile(h.ws("precious.txt"), "utf8")).toBe("keep me");
  });
});
