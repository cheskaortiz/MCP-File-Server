import fs from "node:fs/promises";
import path from "node:path";

/** Error whose message is safe to show to an MCP client. */
export class SandboxError extends Error {
  constructor(
    public readonly code: "INVALID_PATH" | "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "PROTECTED",
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Resolve symlinks on the deepest existing ancestor; re-append the not-yet-existing tail. */
async function realpathOfNearest(p: string): Promise<string> {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // A dangling symlink also yields ENOENT; refuse it (it could point outside).
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink()) {
          throw new SandboxError("OUTSIDE_WORKSPACE", "Path contains a dangling symbolic link.");
        }
      } catch (inner) {
        if (inner instanceof SandboxError) throw inner;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export interface Sandbox {
  /** Real (symlink-resolved) root. */
  readonly root: string;
  /** Validate a client-supplied relative path and return a safe absolute path. */
  resolve(relPath: string): Promise<string>;
  /** Convert an absolute path inside the sandbox back to a POSIX-style relative path. */
  toRelative(absPath: string): string;
}

export async function createSandbox(rootInput: string): Promise<Sandbox> {
  const root = await fs.realpath(rootInput);
  const st = await fs.stat(root);
  if (!st.isDirectory()) throw new Error("Workspace root is not a directory.");

  return {
    root,
    async resolve(relPath: string): Promise<string> {
      if (relPath.includes("\0")) throw new SandboxError("INVALID_PATH", "Path contains a null byte.");
      if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) {
        throw new SandboxError("INVALID_PATH", "Absolute paths are not allowed; use a path relative to the workspace.");
      }
      const lexical = path.resolve(root, relPath);
      if (!isInside(root, lexical)) {
        throw new SandboxError("OUTSIDE_WORKSPACE", "Path escapes the workspace.");
      }
      const real = await realpathOfNearest(lexical);
      if (!isInside(root, real)) {
        throw new SandboxError("OUTSIDE_WORKSPACE", "Path resolves outside the workspace (symbolic link).");
      }
      return real;
    },
    toRelative(absPath: string): string {
      const rel = path.relative(root, absPath);
      return rel === "" ? "." : rel.split(path.sep).join("/");
    },
  };
}
