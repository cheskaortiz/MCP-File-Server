import http from "node:http";
import express from "express";
import type { Request, RequestHandler, Response } from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "../createServer.js";
import { isAuthorized } from "./auth.js";
import type { HttpAuthMode } from "../config/http.js";
import type { FileOAuthProvider } from "../oauth/provider.js";

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MCP_PATH = "/mcp";

export interface HttpOAuthOptions {
  provider: FileOAuthProvider;
  issuerUrl: URL;
  resourceUrl: URL;
}

export interface HttpAppOptions {
  workspaceRoot: string;
  auditLogPath?: string;
  /** Bearer token every /mcp request must present. Never logged. */
  authMode?: HttpAuthMode;
  authToken?: string;
  oauth?: HttpOAuthOptions;
  /** Optional Host-header allow-list (extra defence against DNS rebinding). */
  allowedHosts?: readonly string[];
  maxBodyBytes?: number;
  /** One line per request: method, path, status, duration. Never headers or bodies. */
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "Request body too large."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, "Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname; // query string intentionally dropped
  } catch {
    return "/";
  }
}

function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const full = hostHeader.toLowerCase();
  const withoutPort = full.replace(/:\d+$/, "");
  return allowed.includes(full) || allowed.includes(withoutPort);
}

/**
 * Builds (but does not start) the HTTP server.
 *
 * Stateless Streamable HTTP: every POST gets a fresh McpServer + transport built by the
 * existing createServer(), so tools behave exactly as over stdio. Per-file locks live at
 * module level, so concurrent requests are still serialized per file.
 */
export function createHttpApp(options: HttpAppOptions): http.Server {
  const log = options.log ?? ((line: string) => console.log(line));
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedHosts = options.allowedHosts ?? [];
  const authMode = options.authMode ?? "static";
  if (authMode !== "oauth" && !options.authToken) {
    throw new Error("authToken is required for static or both authentication mode.");
  }
  if (authMode !== "static" && !options.oauth) {
    throw new Error("OAuth provider and URLs are required when OAuth authentication is enabled.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use((req, res, next) => {
    const started = Date.now();
    const pathname = safePathname(req.url);
    res.on("finish", () => {
      log(`${new Date().toISOString()} ${req.method ?? "?"} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (allowedHosts.length > 0 && !hostAllowed(req.headers.host, allowedHosts)) {
      rpcError(res, 403, -32000, "Forbidden host.");
      return;
    }

    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    next();
  });

  if (options.oauth) {
    app.use(
      mcpAuthRouter({
        provider: options.oauth.provider,
        issuerUrl: options.oauth.issuerUrl,
        resourceServerUrl: options.oauth.resourceUrl,
      }),
    );

    app.post(
      "/oauth/consent",
      express.urlencoded({ extended: false, limit: "16kb" }),
      (req, res) => {
        const csrf = typeof req.body?.csrf === "string" ? req.body.csrf : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
        options.oauth!.provider.handleConsent(csrf, password, decision, res).catch((err: unknown) => {
          console.error("OAuth consent error:", err instanceof Error ? err.message : "unknown error");
          if (!res.headersSent) res.status(500).send("Unable to process the authorization request.");
        });
      },
    );
  }

  const oauthBearerAuth: RequestHandler | undefined = options.oauth
    ? requireBearerAuth({
        verifier: options.oauth.provider,
        expectedResource: options.oauth.resourceUrl,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.oauth.resourceUrl),
      })
    : undefined;

  app.use((req, res, next) => {
    if (
      authMode !== "oauth" &&
      options.authToken &&
      isAuthorized(req.headers.authorization, options.authToken)
    ) {
      next();
      return;
    }

    if (oauthBearerAuth) {
      oauthBearerAuth(req, res, next);
      return;
    }

    rpcError(res, 401, -32001, "Unauthorized.", {
      "WWW-Authenticate": 'Bearer realm="mcp-file-server"',
    });
  });

  async function handle(req: Request, res: Response): Promise<void> {
    const pathname = safePathname(req.url);

    if (allowedHosts.length > 0 && !hostAllowed(req.headers.host, allowedHosts)) {
      rpcError(res, 403, -32000, "Forbidden host.");
      return;
    }

    // Only unauthenticated endpoint: reveals nothing but liveness.
    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // Authentication happens BEFORE routing, body parsing, or any MCP code.
    if (
      !req.auth &&
      (!options.authToken || !isAuthorized(req.headers.authorization, options.authToken))
    ) {
      rpcError(res, 401, -32001, "Unauthorized.", { "WWW-Authenticate": 'Bearer realm="mcp-file-server"' });
      return;
    }

    if (pathname !== MCP_PATH) {
      rpcError(res, 404, -32000, "Not found.");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated SSE stream (GET) and no sessions to terminate (DELETE).
      rpcError(res, 405, -32000, "Method not allowed.", { Allow: "POST" });
      return;
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      rpcError(res, 415, -32000, "Content-Type must be application/json.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, maxBody));
    } catch (err) {
      if (err instanceof HttpError) rpcError(res, err.status, -32000, err.message);
      else rpcError(res, 400, -32700, "Parse error.");
      return;
    }

    const mcp = await createMcpServer(options.workspaceRoot, {
      ...(options.auditLogPath !== undefined ? { auditLogPath: options.auditLogPath } : {}),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  app.use((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("Unhandled HTTP error:", err instanceof Error ? err.message : "unknown error");
      rpcError(res, 500, -32603, "Internal server error.");
    });
  });

  return http.createServer(app);
}
