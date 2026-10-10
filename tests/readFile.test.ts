import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("read_file", () => {
  it("returns content, size and a sha256 version", async () => {
    await fs.writeFile(h.ws("a.txt"), "hello\nworld\n");
    const r = await h.call("read_file", { path: "a.txt" });
    expect(r.isError).toBe(false);
    const data = r.json<{ content: string; bytes: number; version: string; truncated: boolean; path: string }>();
    expect(data.content).toBe("hello\nworld\n");
    expect(data.bytes).toBe(12);
    expect(data.truncated).toBe(false);
    expect(data.path).toBe("a.txt");
    expect(data.version).toBe(crypto.createHash("sha256").update("hello\nworld\n").digest("hex"));
  });

  it("truncates to max_bytes but versions the whole file", async () => {
    await fs.writeFile(h.ws("big.txt"), "0123456789");
    const r = await h.call("read_file", { path: "big.txt", max_bytes: 4 });
    const data = r.json<{ content: string; truncated: boolean; bytes: number; version: string }>();
    expect(data.content).toBe("0123");
    expect(data.truncated).toBe(true);
    expect(data.bytes).toBe(10);
    expect(data.version).toBe(crypto.createHash("sha256").update("0123456789").digest("hex"));
  });

  it("reads files in subdirectories", async () => {
    await fs.mkdir(h.ws("src"));
    await fs.writeFile(h.ws("src", "b.ts"), "export {}");
    const r = await h.call("read_file", { path: "src/b.ts" });
    expect(r.json<{ content: string }>().content).toBe("export {}");
  });

  it("returns a clean error for a missing file", async () => {
    const r = await h.call("read_file", { path: "missing.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Path not found.");
  });

  it("refuses directories", async () => {
    await fs.mkdir(h.ws("dir"));
    const r = await h.call("read_file", { path: "dir" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not a regular file");
  });

  it("refuses binary files", async () => {
    await fs.writeFile(h.ws("bin.dat"), Buffer.from([1, 2, 0, 3]));
    const r = await h.call("read_file", { path: "bin.dat" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("binary");
  });

  it("refuses files over 1 MiB", async () => {
    await fs.writeFile(h.ws("huge.txt"), "a".repeat(1_048_577));
    const r = await h.call("read_file", { path: "huge.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("larger");
  });

  it("rejects invalid arguments (schema)", async () => {
    await fs.writeFile(h.ws("a.txt"), "x");
    expect((await h.call("read_file", { path: "a.txt", max_bytes: 0 })).isError).toBe(true);
    expect((await h.call("read_file", { path: "" })).isError).toBe(true);
    expect((await h.call("read_file", {})).isError).toBe(true);
  });
});
