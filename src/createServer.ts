import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSandbox } from "./security/sandbox.js";
import { registerAllTools } from "./tools/index.js";
import { createFileAuditLog, noopAudit } from "./utils/audit.js";

export interface CreateServerOptions {
  /** If omitted, mutating operations are not audited (only used by tests that do not care). */
  auditLogPath?: string;
}

export async function createServer(workspaceRoot: string, options: CreateServerOptions = {}): Promise<McpServer> {
  const sandbox = await createSandbox(workspaceRoot);
  const audit = options.auditLogPath ? createFileAuditLog(options.auditLogPath) : noopAudit;
  const server = new McpServer({ name: "mcp-file-server", version: "0.2.0" });
  registerAllTools(server, { sandbox, audit });
  return server;
}
