import path from "node:path";

export interface Config {
  /** Absolute (not yet symlink-resolved) path of the sandbox root. */
  workspaceRoot: string;
  /** Where the append-only audit log is written. Keep this OUTSIDE the workspace. */
  auditLogPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = env.WORKSPACE_ROOT?.trim() || "./workspace";
  const audit = env.AUDIT_LOG_PATH?.trim() || "./logs/audit.log";
  return { workspaceRoot: path.resolve(workspace), auditLogPath: path.resolve(audit) };
}
