import { SandboxError, type Sandbox } from "./sandbox.js";

/** Handoff files (Milestone 4) must never be deleted by an agent. Compared case-insensitively. */
const PROTECTED_FROM_DELETE = new Set(["project_state.md", "plan_log.md", "checkpoints.md", "decisions.md"]);

/**
 * Extra rules for operations that MODIFY the workspace. `abs` must come from sandbox.resolve().
 * - The workspace root itself cannot be modified.
 * - Anything inside a `.git` directory is off limits: git config can run commands
 *   (e.g. core.fsmonitor), so letting an agent write there would defeat the git_status safeguards.
 */
export function assertWritable(sandbox: Sandbox, abs: string): void {
  const rel = sandbox.toRelative(abs);
  if (rel === ".") throw new SandboxError("INVALID_PATH", "Cannot modify the workspace root.");
  if (rel.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new SandboxError("PROTECTED", "Modifying anything inside .git is not allowed.");
  }
}

export function assertDeletable(sandbox: Sandbox, abs: string): void {
  assertWritable(sandbox, abs);
  const rel = sandbox.toRelative(abs);
  if (PROTECTED_FROM_DELETE.has(rel.toLowerCase())) {
    throw new SandboxError("PROTECTED", "Handoff files are protected and cannot be deleted.");
  }
}
