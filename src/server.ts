import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { createServer } from "./createServer.js";

// Stdio transport (works with MCP Inspector). HTTP comes in Milestone 3.
try {
  process.loadEnvFile(); // loads .env if present
} catch {
  /* no .env file: defaults are used */
}

const config = loadConfig();
const server = await createServer(config.workspaceRoot, { auditLogPath: config.auditLogPath });
await server.connect(new StdioServerTransport());
// IMPORTANT: with stdio, stdout is the protocol channel. Log to stderr only.
console.error(`mcp-file-server running on stdio, workspace: ${config.workspaceRoot}`);
