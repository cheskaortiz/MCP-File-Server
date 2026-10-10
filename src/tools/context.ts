import type { Sandbox } from "../security/sandbox.js";
import type { AuditLog } from "../utils/audit.js";

export interface ToolContext {
  sandbox: Sandbox;
  audit: AuditLog;
}
