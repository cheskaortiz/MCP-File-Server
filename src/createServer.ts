import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSandbox } from "./security/sandbox.js";
import { registerAllTools } from "./tools/index.js";

export async function createServer(workspaceRoot: string): Promise<McpServer> {
  const sandbox = await createSandbox(workspaceRoot);
  const server = new McpServer({ name: "mcp-file-server", version: "0.1.0" });
  registerAllTools(server, sandbox);
  return server;
}
