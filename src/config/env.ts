import path from "node:path";

export interface Config {
  /** Absolute (not yet symlink-resolved) path of the sandbox root. */
  workspaceRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.WORKSPACE_ROOT?.trim() || "./workspace";
  return { workspaceRoot: path.resolve(raw) };
}
