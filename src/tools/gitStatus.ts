import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "../utils/errors.js";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./result.js";

const execFileAsync = promisify(execFile);
const MAX_CHANGES = 200;

/**
 * Git-lite: the ONLY git commands this server can run are the two fixed ones below.
 * No agent-supplied text ever reaches the command line, no shell is used, and
 * core.fsmonitor is forced off (a repo config can otherwise execute programs).
 */
async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env,
    timeout: 5_000,
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
  return stdout;
}

export async function gitStatusTool(ctx: ToolContext) {
  const cwd = ctx.sandbox.root;
  try {
    // --show-cdup prints "" only when cwd is the repository's top level.
    const cdup = (await runGit(cwd, ["rev-parse", "--show-cdup"])).trim();
    if (cdup !== "") {
      throw new ToolError("NOT_A_REPO", "The workspace root is inside a larger git repository, not a repository itself.");
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("GIT_UNAVAILABLE", "git is not installed on the server.");
    }
    throw new ToolError("NOT_A_REPO", "The workspace root is not a git repository.");
  }

  let out: string;
  try {
    out = await runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]);
  } catch {
    throw new ToolError("GIT_FAILED", "git status failed.");
  }

  const lines = out.split("\n").filter((l) => l.length > 0);
  const branchLine = lines.find((l) => l.startsWith("## "));
  const changeLines = lines.filter((l) => !l.startsWith("## "));
  return {
    branch: branchLine ? branchLine.slice(3) : null,
    clean: changeLines.length === 0,
    changes: changeLines.slice(0, MAX_CHANGES).map((l) => ({ status: l.slice(0, 2), path: l.slice(3) })),
    truncated: changeLines.length > MAX_CHANGES,
  };
}

export function registerGitStatus(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "git_status",
    {
      title: "Git status (read-only)",
      description:
        "Show the current branch and changed/untracked files of the workspace's git repository. Read-only and takes no " +
        "arguments. Works only if the workspace root itself is a git repository; otherwise returns an error. Returns " +
        "'status' as the two-letter porcelain code (e.g. '??' untracked, ' M' modified) and is capped at 200 changes. " +
        "This is the only git command the server can run; there is no way to commit, checkout, or run other git commands.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await gitStatusTool(ctx));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
