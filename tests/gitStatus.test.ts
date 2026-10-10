import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasGit = gitAvailable();

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("git_status", () => {
  it("returns a clean error when the workspace is not a git repository", async () => {
    const r = await h.call("git_status");
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(h.tmp); // no host paths leaked
  });

  it.skipIf(!hasGit)("reports untracked files in a repository", async () => {
    execFileSync("git", ["init", "-q"], { cwd: h.workspace });
    await fs.writeFile(h.ws("new.txt"), "x");
    const r = await h.call("git_status");
    expect(r.isError).toBe(false);
    const data = r.json<{ clean: boolean; changes: { status: string; path: string }[]; branch: string | null }>();
    expect(data.clean).toBe(false);
    expect(data.changes).toContainEqual({ status: "??", path: "new.txt" });
    expect(data.branch).not.toBeNull();
  });

  it.skipIf(!hasGit)("reports a clean repository", async () => {
    execFileSync("git", ["init", "-q"], { cwd: h.workspace });
    const r = await h.call("git_status");
    expect(r.json<{ clean: boolean }>().clean).toBe(true);
  });

  it.skipIf(!hasGit)("refuses when the workspace is only a subfolder of a larger repository", async () => {
    execFileSync("git", ["init", "-q"], { cwd: h.tmp }); // repo root is the parent of the workspace
    const r = await h.call("git_status");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("larger git repository");
  });

  it("takes no arguments that could reach the command line", async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === "git_status");
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toHaveLength(0);
  });
});
