import path from "node:path";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type HttpAuthMode = "static" | "oauth" | "both";

export interface HttpOAuthConfig {
  issuerUrl: URL;
  resourceUrl: URL;
  ownerPassword: string;
  storageDirectory: string;
}

export interface HttpConfig {
  host: string;
  port: number;
  authMode: HttpAuthMode;
  authToken?: string;
  oauth?: HttpOAuthConfig;
  /** If non-empty, requests whose Host header is not listed are rejected. */
  allowedHosts: string[];
}

export const MIN_TOKEN_LENGTH = 32;

/**
 * Reads HTTP settings from the environment. Error messages never contain the token value.
 * Variables are prefixed MCP_ because plain HOST/PORT are often already set by the OS or shell.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const rawAuthMode = env.MCP_AUTH_MODE?.trim() || "static";
  if (rawAuthMode !== "static" && rawAuthMode !== "oauth" && rawAuthMode !== "both") {
    throw new ConfigError("MCP_AUTH_MODE must be static, oauth, or both.");
  }
  const authMode: HttpAuthMode = rawAuthMode;

  const authToken = env.MCP_AUTH_TOKEN?.trim() ?? "";
  if (authMode !== "oauth" || authToken !== "") {
    if (authToken === "") {
      throw new ConfigError("MCP_AUTH_TOKEN is required for static or both authentication mode. Generate one with: npm run gen-token");
    }
    if (authToken.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: npm run gen-token`);
    }
    if (/\s/.test(authToken)) {
      throw new ConfigError("MCP_AUTH_TOKEN must not contain whitespace.");
    }
  }

  let oauth: HttpOAuthConfig | undefined;
  if (authMode !== "static") {
    const issuerUrl = parseHttpsUrl(env.MCP_OAUTH_ISSUER_URL, "MCP_OAUTH_ISSUER_URL");
    if (
      issuerUrl.pathname !== "/" ||
      issuerUrl.search ||
      issuerUrl.hash ||
      issuerUrl.username ||
      issuerUrl.password
    ) {
      throw new ConfigError("MCP_OAUTH_ISSUER_URL must be an HTTPS origin without a path, query, or fragment.");
    }

    const resourceUrl = parseHttpsUrl(env.MCP_OAUTH_RESOURCE_URL, "MCP_OAUTH_RESOURCE_URL");
    if (resourceUrl.search || resourceUrl.hash || resourceUrl.username || resourceUrl.password) {
      throw new ConfigError("MCP_OAUTH_RESOURCE_URL must not contain credentials, a query, or a fragment.");
    }

    const ownerPassword = env.MCP_OAUTH_OWNER_PASSWORD ?? "";
    if (ownerPassword.length < 32) {
      throw new ConfigError("MCP_OAUTH_OWNER_PASSWORD must contain at least 32 characters.");
    }

    const storageDirectory = env.MCP_OAUTH_STORAGE_DIR?.trim() ?? "";
    if (!path.isAbsolute(storageDirectory)) {
      throw new ConfigError("MCP_OAUTH_STORAGE_DIR must be an absolute path outside WORKSPACE_ROOT.");
    }

    oauth = { issuerUrl, resourceUrl, ownerPassword, storageDirectory: path.resolve(storageDirectory) };
  }

  const host = env.MCP_HOST?.trim() || "127.0.0.1";

  const rawPort = env.MCP_PORT?.trim() || "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("MCP_PORT must be an integer between 1 and 65535.");
  }

  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  return {
    host,
    port,
    authMode,
    ...(authToken ? { authToken } : {}),
    ...(oauth ? { oauth } : {}),
    allowedHosts,
  };
}

function parseHttpsUrl(raw: string | undefined, variable: string): URL {
  if (!raw?.trim()) {
    throw new ConfigError(`${variable} is required when OAuth authentication is enabled.`);
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(`${variable} must be a valid absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(`${variable} must use HTTPS.`);
  }
  return url;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
