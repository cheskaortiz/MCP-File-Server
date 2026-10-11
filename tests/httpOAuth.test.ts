import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createHttpApp } from "../src/http/httpApp.js";
import { FileOAuthProvider } from "../src/oauth/provider.js";
import { OAuthStorage } from "../src/oauth/storage.js";

const ISSUER_URL = new URL("https://auth.example.test");
const RESOURCE_URL = new URL("https://files.example.test/mcp");
const REDIRECT_URI = "http://127.0.0.1:43210/callback";
const OWNER_PASSWORD = "test-owner-password-that-is-long-enough";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "oauth-http-test", version: "0.0.0" },
  },
};

let temporaryDirectory: string;
let server: http.Server;
let baseUrl: string;
let provider: FileOAuthProvider;
let clientId: string;
let registeredRedirectUris: string[];

beforeAll(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-http-test-"));
  const workspaceRoot = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceRoot);
  const storage = new OAuthStorage({
    directory: path.join(temporaryDirectory, "oauth-state"),
  });
  await storage.initialize();

  provider = new FileOAuthProvider({
    storage,
    ownerPassword: OWNER_PASSWORD,
    issuerUrl: ISSUER_URL,
  });
  server = createHttpApp({
    workspaceRoot,
    authMode: "oauth",
    oauth: { provider, issuerUrl: ISSUER_URL, resourceUrl: RESOURCE_URL },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth HTTP test server did not bind to a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  const registrationResponse = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "oauth-http-test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registrationResponse.status).toBe(201);
  const registeredClient = await registrationResponse.json();
  clientId = registeredClient.client_id;
  registeredRedirectUris = registeredClient.redirect_uris;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function issueAccessToken(): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL("/authorize", baseUrl);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE_URL.href,
  }).toString();

  const authorizationResponse = await fetch(authorizationUrl);
  expect(authorizationResponse.status).toBe(200);
  const html = await authorizationResponse.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const formAction = html.match(/<form\b[^>]*\baction="([^"]+)"/)?.[1];
  expect(csrf).toBeDefined();
  expect(formAction).toBeDefined();

  expect(formAction).toBe("/oauth/consent");
  expect(new URL(authorizationResponse.url).origin).not.toBe(ISSUER_URL.origin);
  const consentUrl = new URL(formAction!, authorizationResponse.url);
  expect(consentUrl.origin).toBe(new URL(authorizationResponse.url).origin);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const csp = authorizationResponse.headers.get("content-security-policy");
  expect(csp).toBe(
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(REDIRECT_URI).origin}; base-uri 'none'; frame-ancestors 'none'`,
  );
  const formActionDirective = csp!
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action "));
  expect(formActionDirective?.split(/\s+/)).toEqual([
    "form-action",
    "'self'",
    new URL(REDIRECT_URI).origin,
  ]);

  const consentResponse = await fetch(
    consentUrl,
    {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf: csrf!,
      password: OWNER_PASSWORD,
      decision: "allow",
    }),
    },
  );
  expect(consentResponse.status).toBe(302);
  const redirect = consentResponse.headers.get("location");
  expect(redirect).toBeTruthy();
  const code = new URL(redirect!).searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE_URL.href,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = await tokenResponse.json();
  expect(tokens.access_token).toBeTruthy();
  return tokens.access_token as string;
}

describe("OAuth-enabled HTTP app", () => {
  it("registers a dynamic public client for the consent flow", () => {
    expect(clientId).toBeTruthy();
    expect(registeredRedirectUris).toEqual([REDIRECT_URI]);
  });

  it("allows only the registered HTTPS callback origin in the consent CSP", async () => {
    const callbackUri = "https://claude.ai/api/mcp/auth_callback";
    const registrationResponse = await fetch(new URL("/register", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "claude-callback-test",
        redirect_uris: [callbackUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const client = await registrationResponse.json();

    const authorizationUrl = new URL("/authorize", baseUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callbackUri,
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    }).toString();

    const authorizationResponse = await fetch(authorizationUrl);
    expect(authorizationResponse.status).toBe(200);
    const html = await authorizationResponse.text();
    expect(html).toContain('<form method="post" action="/oauth/consent">');

    const csp = authorizationResponse.headers.get("content-security-policy");
    expect(csp).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("does not allow an unregistered redirect origin in the consent CSP", async () => {
    const authorizationUrl = new URL("/authorize", baseUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example/callback",
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    }).toString();

    const response = await fetch(authorizationUrl);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it("omits non-HTTP callback schemes from the CSP source list", async () => {
    const callbackUri = "com.example.mcp:/oauth/callback";
    const registrationResponse = await fetch(new URL("/register", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "custom-scheme-test",
        redirect_uris: [callbackUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const client = await registrationResponse.json();
    const authorizationUrl = new URL("/authorize", baseUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callbackUri,
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    }).toString();

    const response = await fetch(authorizationUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("rejects consent without a live pending authorization", async () => {
    const response = await fetch(new URL("/oauth/consent", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: "unrecognized-csrf-value",
        password: OWNER_PASSWORD,
        decision: "allow",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      "Authorization expired or invalid. Try again.",
    );
  });

  it("replays duplicate consent submissions without issuing another code", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizationUrl = new URL("/authorize", baseUrl);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE_URL.href,
    }).toString();

    const rateLimitErrors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      rateLimitErrors.push(args.map(String).join(" "));
    });
    let authorizationResponse: Response;
    let registrationResponse: Response;
    try {
      registrationResponse = await fetch(new URL("/register", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.7",
        },
        body: JSON.stringify({
          client_name: "forwarded-header-test",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      });
      authorizationResponse = await fetch(authorizationUrl, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(registrationResponse.status).toBe(201);
    expect(authorizationResponse.status).toBe(200);
    const html = await authorizationResponse.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeDefined();

    const consentRequest = (password = OWNER_PASSWORD) =>
      fetch(new URL("/oauth/consent", baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: csrf!,
          password,
          decision: "allow",
        }),
      });

    let firstConsent: Response;
    let replayedConsent: Response;
    [firstConsent, replayedConsent] = await Promise.all([
      consentRequest(),
      consentRequest(),
    ]);

    expect(firstConsent.status).toBe(302);
    expect(replayedConsent.status).toBe(302);
    expect((await consentRequest("incorrect owner password")).status).toBe(401);
    const firstLocation = firstConsent.headers.get("location");
    expect(firstLocation).toBeTruthy();
    expect(replayedConsent.headers.get("location")).toBe(firstLocation);
    expect(rateLimitErrors.join("\n")).not.toContain(
      "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR",
    );

    const code = new URL(firstLocation!).searchParams.get("code");
    expect(code).toBeTruthy();
    const tokenRequest = () =>
      fetch(new URL("/token", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code!,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          resource: RESOURCE_URL.href,
        }),
      });
    expect((await tokenRequest()).status).toBe(200);
    const reusedCodeResponse = await tokenRequest();
    expect(reusedCodeResponse.status).toBe(400);
    await expect(reusedCodeResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("serves OAuth authorization-server and protected-resource metadata", async () => {
    const authorizationMetadata = await fetch(
      new URL("/.well-known/oauth-authorization-server", baseUrl),
    );
    expect(authorizationMetadata.status).toBe(200);
    await expect(authorizationMetadata.json()).resolves.toMatchObject({
      issuer: ISSUER_URL.href,
      authorization_endpoint: new URL("/authorize", ISSUER_URL).href,
      token_endpoint: new URL("/token", ISSUER_URL).href,
      registration_endpoint: new URL("/register", ISSUER_URL).href,
    });

    const resourceMetadata = await fetch(
      new URL(
        new URL(getOAuthProtectedResourceMetadataUrl(RESOURCE_URL)).pathname,
        baseUrl,
      ),
    );
    expect(resourceMetadata.status).toBe(200);
    await expect(resourceMetadata.json()).resolves.toMatchObject({
      resource: RESOURCE_URL.href,
      authorization_servers: [ISSUER_URL.href],
    });
  });

  it("rejects invalid OAuth bearer tokens", async () => {
    const response = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(INITIALIZE),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_token" });
    expect(response.headers.get("www-authenticate")).toContain(
      getOAuthProtectedResourceMetadataUrl(RESOURCE_URL),
    );
  });

  it("accepts a valid OAuth token for the MCP resource", async () => {
    const accessToken = await issueAccessToken();

    const response = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "mcp-file-server" } },
    });
  });
});
