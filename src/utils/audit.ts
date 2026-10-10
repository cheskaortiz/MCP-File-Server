import fs from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
  tool: string;
  action: string;
  /** Workspace-relative path. Never log file contents. */
  path: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export function createFileAuditLog(filePath: string): AuditLog {
  return {
    async record(entry) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      await fs.appendFile(filePath, line + "\n", "utf8");
    },
  };
}

export const noopAudit: AuditLog = {
  async record() {
    /* auditing disabled (used by tests that do not care) */
  },
};

/** For non-destructive operations: a logging failure must not undo a successful write. */
export async function recordBestEffort(audit: AuditLog, entry: AuditEntry): Promise<void> {
  try {
    await audit.record(entry);
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}
