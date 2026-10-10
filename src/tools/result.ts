import { SandboxError } from "../security/sandbox.js";
import { ToolError } from "../utils/errors.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Convert any thrown error into a client-safe tool error (no stack traces, no host paths). */
export function fail(err: unknown): ToolResult {
  let message = "Internal error.";
  if (err instanceof SandboxError || err instanceof ToolError) {
    message = err.message;
  } else {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") message = "Path not found.";
    else if (code === "ENOTDIR") message = "A path component is not a directory.";
    else if (code === "EISDIR") message = "Path is a directory.";
    else if (code === "EEXIST") message = "Path conflicts with an existing file or directory.";
    else if (code === "EACCES" || code === "EPERM") message = "Permission denied.";
    else console.error("Unexpected tool error:", err); // stderr only; never sent to the client
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}
