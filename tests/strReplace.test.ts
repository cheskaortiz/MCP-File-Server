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

describe("str_replace", () => {
  it("replaces a unique occurrence and reports line and versions", async () => {
    await fs.writeFile(h.ws("a.txt"), "one\ntwo\nthree\n");
    const r = await h.call("str_replace", { path: "a.txt", old_str: "two", new_str: "2" });
    expect(r.isError).toBe(false);
    const data = r.json<{ line: number; replaced: number; previous_version: string; version: string }>();
    expect(data.replaced).toBe(1);
    expect(data.line).toBe(2);
    expect(data.previous_version).toBe(sha("one\ntwo\nthree\n"));
    expect(data.version).toBe(sha("one\n2\nthree\n"));
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("one\n2\nthree\n");
  });

  it("fails when old_str is not found, changing nothing", async () => {
    await fs.writeFile(h.ws("a.txt"), "abc");
    const r = await h.call("str_replace", { path: "a.txt", old_str: "zzz", new_str: "y" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("abc");
  });

  it("fails when old_str is ambiguous, changing nothing", async () => {
    await fs.writeFile(h.ws("a.txt"), "x = 1\nx = 1\n");
    const r = await h.call("str_replace", { path: "a.txt", old_str: "x = 1", new_str: "x = 2" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("2 locations");
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("x = 1\nx = 1\n");
  });

  it("treats overlapping matches as ambiguous", async () => {
    await fs.writeFile(h.ws("a.txt"), "aaa");
    const r = await h.call("str_replace", { path: "a.txt", old_str: "aa", new_str: "b" });
    expect(r.isError).toBe(true);
  });

  it("inserts new_str literally (no $-pattern expansion)", async () => {
    await fs.writeFile(h.ws("a.txt"), "price: X");
    await h.call("str_replace", { path: "a.txt", old_str: "X", new_str: "$& and $1 and $$" });
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("price: $& and $1 and $$");
  });

  it("can delete text with an empty new_str", async () => {
    await fs.writeFile(h.ws("a.txt"), "keep REMOVE keep");
    await h.call("str_replace", { path: "a.txt", old_str: " REMOVE", new_str: "" });
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("keep keep");
  });

  it("honours if_version", async () => {
    await fs.writeFile(h.ws("a.txt"), "hello");
    const stale = await h.call("str_replace", { path: "a.txt", old_str: "hello", new_str: "bye", if_version: sha("old") });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("Version conflict");
    expect(await fs.readFile(h.ws("a.txt"), "utf8")).toBe("hello");

    const good = await h.call("str_replace", { path: "a.txt", old_str: "hello", new_str: "bye", if_version: sha("hello") });
    expect(good.isError).toBe(false);
  });

  it("errors on missing files, identical strings, and empty old_str", async () => {
    expect((await h.call("str_replace", { path: "nope.txt", old_str: "a", new_str: "b" })).text).toBe("Path not found.");
    await fs.writeFile(h.ws("a.txt"), "a");
    expect((await h.call("str_replace", { path: "a.txt", old_str: "a", new_str: "a" })).isError).toBe(true);
    expect((await h.call("str_replace", { path: "a.txt", old_str: "", new_str: "b" })).isError).toBe(true);
  });

  it("refuses binary files and .git paths", async () => {
    await fs.writeFile(h.ws("bin.dat"), Buffer.from([0, 1, 2]));
    expect((await h.call("str_replace", { path: "bin.dat", old_str: "a", new_str: "b" })).isError).toBe(true);
    await fs.mkdir(h.ws(".git"));
    await fs.writeFile(h.ws(".git", "config"), "[core]\n");
    const r = await h.call("str_replace", { path: ".git/config", old_str: "core", new_str: "evil" });
    expect(r.isError).toBe(true);
    expect(await fs.readFile(h.ws(".git", "config"), "utf8")).toBe("[core]\n");
  });
});
