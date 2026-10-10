import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";

/** Largest file any tool will read, write, or hash (1 MiB). */
export const MAX_FILE_BYTES = 1_048_576;

export function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface TextFile {
  buf: Buffer;
  text: string;
  bytes: number;
  /** sha256 of the file's bytes; used for if_version checks. */
  version: string;
}

export async function readTextFile(abs: string): Promise<TextFile> {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new ToolError("NOT_A_FILE", "Path is not a regular file.");
  if (st.size > MAX_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `File is larger than the ${MAX_FILE_BYTES}-byte limit.`);
  }
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) {
    throw new ToolError("BINARY_FILE", "File appears to be binary; only text files are supported.");
  }
  return { buf, text: buf.toString("utf8"), bytes: buf.length, version: sha256(buf) };
}

/** Version (hash) of any existing regular file within the size limit. */
export async function readVersion(abs: string, size: number): Promise<string> {
  if (size > MAX_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `File is larger than the ${MAX_FILE_BYTES}-byte limit.`);
  }
  return sha256(await fs.readFile(abs));
}

export async function statOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function assertTextSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `Content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  }
}

export function versionConflict(current: string | null): ToolError {
  return new ToolError(
    "VERSION_CONFLICT",
    current === null
      ? "Version conflict: the file's state does not match if_version. Re-read it and retry."
      : `Version conflict: the file changed since you read it (current version ${current}). Re-read it and retry.`,
  );
}

/** Write to a temp file in the same directory, fsync, then rename over the target. */
export async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
