import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globToRegExp, makeGlobMatcher } from "../src/utils/glob.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await fs.mkdir(h.ws("src", "lib"), { recursive: true });
  await fs.mkdir(h.ws("node_modules", "pkg"), { recursive: true });
  await fs.writeFile(h.ws("README.md"), "# Title\nTODO: write docs\n");
  await fs.writeFile(h.ws("src", "a.ts"), "export const a = 1;\n// todo: refactor\n");
  await fs.writeFile(h.ws("src", "lib", "b.ts"), "export function add(a, b) { return a + b; }\n");
  await fs.writeFile(h.ws("node_modules", "pkg", "index.ts"), "TODO in dependency\n");
  await fs.writeFile(h.ws("data.bin"), Buffer.from([0, 1, 2, 84, 79, 68, 79]));
});
afterEach(async () => {
  await h.close();
});

describe("glob helper", () => {
  it("supports *, **, ? and escapes regex characters", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a.tsx")).toBe(false);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.c").test("abc")).toBe(false);
    expect(makeGlobMatcher("src/**/*.ts")("src/lib/b.ts")).toBe(true);
    expect(makeGlobMatcher("src/**/*.ts")("src/a.ts")).toBe(true);
    expect(makeGlobMatcher("*.ts")("src/lib/b.ts")).toBe(true); // name-only pattern
    expect(makeGlobMatcher("*.ts")("a.md")).toBe(false);
  });
});

describe("search_files", () => {
  it("finds files by name at any depth, skipping node_modules", async () => {
    const r = await h.call("search_files", { pattern: "*.ts" });
    expect(r.isError).toBe(false);
    const paths = r.json<{ matches: { path: string }[] }>().matches.map((m) => m.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/lib/b.ts"]);
  });

  it("matches path globs and is case-insensitive", async () => {
    const r = await h.call("search_files", { pattern: "SRC/LIB/*.TS" });
    expect(r.json<{ matches: { path: string }[] }>().matches.map((m) => m.path)).toEqual(["src/lib/b.ts"]);
  });

  it("limits the search directory and honours max_results", async () => {
    const scoped = await h.call("search_files", { pattern: "*", path: "src/lib" });
    expect(scoped.json<{ matches: { path: string }[] }>().matches.map((m) => m.path)).toEqual(["src/lib/b.ts"]);
    const capped = await h.call("search_files", { pattern: "*", max_results: 1 });
    const data = capped.json<{ matches: unknown[]; truncated: boolean }>();
    expect(data.matches).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  it("errors on missing paths and file paths", async () => {
    expect((await h.call("search_files", { pattern: "*", path: "nope" })).text).toBe("Path not found.");
    expect((await h.call("search_files", { pattern: "*", path: "README.md" })).isError).toBe(true);
    expect((await h.call("search_files", { pattern: "" })).isError).toBe(true);
  });
});

describe("search_code", () => {
  type Found = { matches: { path: string; line: number; text: string }[]; truncated: boolean; skipped: { binary: number } };

  it("finds literal text case-insensitively with line numbers", async () => {
    const r = await h.call("search_code", { query: "todo" });
    expect(r.isError).toBe(false);
    const found = r.json<Found>().matches.map((m) => `${m.path}:${m.line}`).sort();
    expect(found).toEqual(["README.md:2", "src/a.ts:2"]); // node_modules and binary skipped
  });

  it("supports case_sensitive and glob filters", async () => {
    const cs = await h.call("search_code", { query: "TODO", case_sensitive: true });
    expect(cs.json<Found>().matches.map((m) => m.path)).toEqual(["README.md"]);
    const filtered = await h.call("search_code", { query: "todo", glob: "*.ts" });
    expect(filtered.json<Found>().matches.map((m) => m.path)).toEqual(["src/a.ts"]);
  });

  it("treats the query as a literal, not a regex", async () => {
    await fs.writeFile(h.ws("re.txt"), "call f(a.b) now\nplain\n");
    const r = await h.call("search_code", { query: "f(a.b)" });
    expect(r.json<Found>().matches).toHaveLength(1);
    const noRegex = await h.call("search_code", { query: ".*" });
    expect(noRegex.json<Found>().matches).toHaveLength(0);
  });

  it("reports skipped binary files", async () => {
    const r = await h.call("search_code", { query: "zzz-nothing" });
    expect(r.json<Found>().skipped.binary).toBe(1);
  });

  it("searches a single file when path is a file", async () => {
    const r = await h.call("search_code", { query: "add", path: "src/lib/b.ts" });
    expect(r.json<Found>().matches).toHaveLength(1);
  });

  it("bounds results and long lines", async () => {
    await fs.writeFile(h.ws("many.txt"), "hit\n".repeat(10));
    const capped = await h.call("search_code", { query: "hit", path: "many.txt", max_results: 3 });
    const data = capped.json<Found>();
    expect(data.matches).toHaveLength(3);
    expect(data.truncated).toBe(true);

    await fs.writeFile(h.ws("long.txt"), "needle " + "x".repeat(1000));
    const long = await h.call("search_code", { query: "needle", path: "long.txt" });
    expect(long.json<Found>().matches[0]?.text.length).toBeLessThanOrEqual(301);
  });

  it("validates input", async () => {
    expect((await h.call("search_code", { query: "" })).isError).toBe(true);
    expect((await h.call("search_code", { query: "a", max_results: 0 })).isError).toBe(true);
    expect((await h.call("search_code", { query: "a", path: "nope" })).text).toBe("Path not found.");
  });
});
