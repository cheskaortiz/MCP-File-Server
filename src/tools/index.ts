import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerDeleteFile } from "./deleteFile.js";
import { registerGitStatus } from "./gitStatus.js";
import { registerListFiles } from "./listFiles.js";
import { registerReadFile } from "./readFile.js";
import { registerRepoMap } from "./repoMap.js";
import { registerSearchCode } from "./searchCode.js";
import { registerSearchFiles } from "./searchFiles.js";
import { registerStrReplace } from "./strReplace.js";
import { registerWriteFile } from "./writeFile.js";

/** Single place where every tool is registered (9 tools). */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerListFiles(server, ctx.sandbox);
  registerReadFile(server, ctx);
  registerWriteFile(server, ctx);
  registerStrReplace(server, ctx);
  registerDeleteFile(server, ctx);
  registerSearchFiles(server, ctx);
  registerSearchCode(server, ctx);
  registerRepoMap(server, ctx);
  registerGitStatus(server, ctx);
}
