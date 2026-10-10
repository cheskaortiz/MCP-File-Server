import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sandbox } from "../security/sandbox.js";
import { registerListFiles } from "./listFiles.js";

/** Single place where every tool is registered. */
export function registerAllTools(server: McpServer, sandbox: Sandbox): void {
  registerListFiles(server, sandbox);
}
