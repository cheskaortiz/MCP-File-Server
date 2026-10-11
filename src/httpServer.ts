import { loadConfig } from "./config/env.js";
import { ConfigError, isLoopbackHost, loadHttpConfig } from "./config/http.js";
import { createHttpApp } from "./http/httpApp.js";

// Streamable HTTP entry point. The stdio entry point (src/server.ts) is unchanged.
try {
  process.loadEnvFile(); // loads .env from the current directory if present
} catch {
  /* no .env file: rely on the real environment */
}

function loadAll() {
  try {
    return { config: loadConfig(), httpConfig: loadHttpConfig() };
  } catch (err) {
    console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : "Failed to load configuration.");
    process.exit(1);
  }
}
const { config, httpConfig } = loadAll();

const app = createHttpApp({
  workspaceRoot: config.workspaceRoot,
  auditLogPath: config.auditLogPath,
  authToken: httpConfig.authToken,
  allowedHosts: httpConfig.allowedHosts,
});

app.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${httpConfig.port} is already in use.` : `Server error: ${err.message}`);
  process.exit(1);
});

app.listen(httpConfig.port, httpConfig.host, () => {
  console.log(`mcp-file-server HTTP listening on http://${httpConfig.host}:${httpConfig.port}/mcp (bearer token required)`);
  console.log(`workspace: ${config.workspaceRoot}`);
  if (!isLoopbackHost(httpConfig.host)) {
    console.warn(`WARNING: bound to non-loopback address ${httpConfig.host}. Make sure this is intentional and the token is strong.`);
  }
  if (httpConfig.allowedHosts.length > 0) console.log(`Host allow-list active (${httpConfig.allowedHosts.length} entries)`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  app.close(() => process.exit(0));
  app.closeIdleConnections();
  setTimeout(() => {
    app.closeAllConnections();
    process.exit(0);
  }, 5_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
