import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "../security/sandbox.js";

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface WalkEntry {
  abs: string;
  rel: string;
  type: "file" | "directory";
  /** 1 = directly inside the start directory. */
  depth: number;
}

export interface WalkOptions {
  maxDepth: number;
  maxVisited: number;
  ignoreDirs?: ReadonlySet<string>;
}

export interface WalkState {
  visited: number;
  /** Set when the walk stopped early because maxVisited was reached. */
  limitHit: boolean;
}

/**
 * Bounded directory walk. Symbolic links are never followed or yielded, so a walk that
 * starts inside the sandbox cannot leave it. `startAbs` must come from sandbox.resolve().
 */
export async function* walk(
  sandbox: Sandbox,
  startAbs: string,
  options: WalkOptions,
  state: WalkState,
): AsyncGenerator<WalkEntry> {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORED_DIRS;

  async function* walkDir(dir: string, depth: number): AsyncGenerator<WalkEntry> {
    if (depth > options.maxDepth) return;
    let items: Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth > 1) return; // skip unreadable subdirectories
      throw err;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const isDir = item.isDirectory();
      if (isDir && ignore.has(item.name.toLowerCase())) continue;
      if (!isDir && !item.isFile()) continue;
      if (state.visited >= options.maxVisited) {
        state.limitHit = true;
        return;
      }
      state.visited++;
      const abs = path.join(dir, item.name);
      yield { abs, rel: sandbox.toRelative(abs), type: isDir ? "directory" : "file", depth };
      if (isDir) {
        yield* walkDir(abs, depth + 1);
        if (state.limitHit) return;
      }
    }
  }

  yield* walkDir(startAbs, 1);
}
