import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await fs.mkdir(h.ws("src", "deep", "deeper"), { recursive: true });
  await fs.mkdir(h.ws("node_modules", "x"), { recursive: true });
  await fs.mkdir(h.ws(".git"));
  await fs.writeFile(h.ws("README.md"), "hello");
  await fs.writeFile(h.ws("src", "a.ts"), "1");
  await fs.writeFile(h.ws("src", "deep", "b.ts"), "22");
  await fs.writeFile(h.ws("src", "deep", "deeper", "c.ts"), "333");
  await fs.writeFile(h.ws("node_modules", "x", "skip.js"), "x");
});
afterEach(async () => {
  await h.close();
});

type Map_ = { tree: string; files: number; directories: number; by_extension: Record<string, number>; truncated: boolean };

describe("repo_map", () => {
  it("renders an indented tree with sizes, skipping .git and node_modules", async () => {
    const r = await h.call("repo_map", {});
    expect(r.isError).toBe(false);
    const m = r.json<Map_>();
    expect(m.tree).toContain("src/");
    expect(m.tree).toContain("  a.ts (1 B)");
    expect(m.tree).toContain("README.md (5 B)");
    expect(m.tree).not.toContain("node_modules");
    expect(m.tree).not.toContain(".git");
    // c.ts lives at depth 4, beyond the default max_depth of 3
    expect(m.by_extension[".ts"]).toBe(2);
    expect(m.by_extension[".md"]).toBe(1);
    expect(m.truncated).toBe(false);
  });

  it("honours max_depth", async () => {
    const m = (await h.call("repo_map", { max_depth: 1 })).json<Map_>();
    expect(m.tree).toContain("src/");
    expect(m.tree).not.toContain("a.ts");
    const deep = (await h.call("repo_map", { max_depth: 3 })).json<Map_>();
    expect(deep.tree).toContain("deeper/");
    expect(deep.tree).not.toContain("c.ts");
  });

  it("honours max_entries and reports truncation", async () => {
    const m = (await h.call("repo_map", { max_entries: 2 })).json<Map_>();
    expect(m.files + m.directories).toBe(2);
    expect(m.truncated).toBe(true);
  });

  it("maps a subdirectory and validates input", async () => {
    const m = (await h.call("repo_map", { path: "src/deep" })).json<Map_>();
    expect(m.tree).toContain("b.ts (2 B)");
    expect((await h.call("repo_map", { path: "README.md" })).isError).toBe(true);
    expect((await h.call("repo_map", { path: "nope" })).text).toBe("Path not found.");
    expect((await h.call("repo_map", { max_depth: 99 })).isError).toBe(true);
  });
});
