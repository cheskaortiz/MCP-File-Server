import { loadConfig } from "./config/env.js";
import { ConfigError, isLoopbackHost, loadHttpConfig } from "./config/http.js";
import { createHttpApp } from "./http/httpApp.js";
import { FileOAuthProvider } from "./oauth/provider.js";
import { OAuthStorage } from "./oauth/storage.js";
import path from "node:path";

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
async function startHttpServer(): Promise<void> {
  const { config, httpConfig } = loadAll();
  let oauth: {
    provider: FileOAuthProvider;
    issuerUrl: URL;
    resourceUrl: URL;
  } | undefined;

  if (httpConfig.oauth) {
    const storageDirectory = path.resolve(httpConfig.oauth.storageDirectory);
    const relativeStoragePath = path.relative(config.workspaceRoot, storageDirectory);
    if (
      relativeStoragePath === "" ||
      (relativeStoragePath !== ".." &&
        !relativeStoragePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeStoragePath))
    ) {
      throw new ConfigError("MCP_OAUTH_STORAGE_DIR must be outside WORKSPACE_ROOT.");
    }

    const storage = new OAuthStorage({ directory: storageDirectory });
    await storage.initialize();
    oauth = {
      provider: new FileOAuthProvider({
        storage,
        ownerPassword: httpConfig.oauth.ownerPassword,
        issuerUrl: httpConfig.oauth.issuerUrl,
      }),
      issuerUrl: httpConfig.oauth.issuerUrl,
      resourceUrl: httpConfig.oauth.resourceUrl,
    };
  }

  const app = createHttpApp({
    workspaceRoot: config.workspaceRoot,
    auditLogPath: config.auditLogPath,
    authMode: httpConfig.authMode,
    ...(httpConfig.authToken ? { authToken: httpConfig.authToken } : {}),
    ...(oauth ? { oauth } : {}),
    allowedHosts: httpConfig.allowedHosts,
  });

  app.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${httpConfig.port} is already in use.` : `Server error: ${err.message}`);
    process.exit(1);
  });

  app.listen(httpConfig.port, httpConfig.host, () => {
    console.log(`mcp-file-server HTTP listening on http://${httpConfig.host}:${httpConfig.port}/mcp (${httpConfig.authMode} authentication)`);
    console.log(`workspace: ${config.workspaceRoot}`);
    if (!isLoopbackHost(httpConfig.host)) {
      console.warn(`WARNING: bound to non-loopback address ${httpConfig.host}. Make sure this is intentional and the authentication mode is appropriate.`);
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
}

startHttpServer().catch((err: unknown) => {
  console.error(
    err instanceof ConfigError
      ? `Configuration error: ${err.message}`
      : `Failed to initialize HTTP server: ${err instanceof Error ? err.message : "unknown error"}`,
  );
  process.exit(1);
});
