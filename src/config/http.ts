export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface HttpConfig {
  host: string;
  port: number;
  authToken: string;
  /** If non-empty, requests whose Host header is not listed are rejected. */
  allowedHosts: string[];
}

export const MIN_TOKEN_LENGTH = 32;

/**
 * Reads HTTP settings from the environment. Error messages never contain the token value.
 * Variables are prefixed MCP_ because plain HOST/PORT are often already set by the OS or shell.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const authToken = env.MCP_AUTH_TOKEN?.trim() ?? "";
  if (authToken === "") {
    throw new ConfigError("MCP_AUTH_TOKEN is required for the HTTP server. Generate one with: npm run gen-token");
  }
  if (authToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: npm run gen-token`);
  }
  if (/\s/.test(authToken)) {
    throw new ConfigError("MCP_AUTH_TOKEN must not contain whitespace.");
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

  return { host, port, authToken, allowedHosts };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
