import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { FileOAuthProvider } from "../src/oauth/provider.js";
import { OAuthStorage } from "../src/oauth/storage.js";

const ISSUER_URL = new URL("https://oauth.example.test");
const RESOURCE_URL = new URL("https://files.example.test/mcp");
const REDIRECT_URI = "http://127.0.0.1:43210/callback";
const OWNER_PASSWORD = "test-owner-password-that-is-long-enough";

let temporaryDirectory: string;
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
let provider: FileOAuthProvider;
let storage: OAuthStorage;
let clientId: string;

beforeAll(async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");

  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-test-"));
  storage = new OAuthStorage({ directory: temporaryDirectory });
  await storage.initialize();

  provider = new FileOAuthProvider({
    storage,
    ownerPassword: OWNER_PASSWORD,
    issuerUrl: ISSUER_URL,
  });
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
  });
  clientId = client.client_id;

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mcpAuthRouter({ provider, issuerUrl: ISSUER_URL }));
  app.post("/oauth/consent", async (req, res) => {
    await provider.handleConsent(
      String(req.body.csrf ?? ""),
      String(req.body.password ?? ""),
      String(req.body.decision ?? ""),
      res,
    );
  });

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth test server did not bind to a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const fs = await import("node:fs/promises");

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

async function createAuthorizationCode(
  verifier: string,
  resource?: string,
): Promise<string> {
  const codeChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const authorizationParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (resource !== undefined) {
    authorizationParams.set("resource", resource);
  }
  const authorizationUrl = new URL("/authorize", baseUrl);
  authorizationUrl.search = authorizationParams.toString();

  const authorizationResponse = await fetch(authorizationUrl);
  expect(authorizationResponse.status).toBe(200);
  const html = await authorizationResponse.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeDefined();

  const consentResponse = await fetch(new URL("/oauth/consent", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf: csrf!,
      password: OWNER_PASSWORD,
      decision: "allow",
    }),
  });
  expect(consentResponse.status).toBe(302);
  const location = consentResponse.headers.get("location");
  expect(location).toBeTruthy();
  const code = new URL(location!).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function exchangeAuthorizationCode(
  code: string,
  verifier?: string,
  resource?: string,
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT_URI,
  });
  if (verifier !== undefined) {
    body.set("code_verifier", verifier);
  }
  if (resource !== undefined) {
    body.set("resource", resource);
  }

  return fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function exchangeRefreshToken(
  refreshToken: string,
  options: { scope?: string; resource?: string } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (options.scope !== undefined) {
    body.set("scope", options.scope);
  }
  if (options.resource !== undefined) {
    body.set("resource", options.resource);
  }

  return fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function createRefreshToken(
  resource: string = RESOURCE_URL.href,
): Promise<string> {
  const verifier = newVerifier();
  const code = await createAuthorizationCode(verifier, resource);
  const response = await exchangeAuthorizationCode(
    code,
    verifier,
    resource,
  );
  expect(response.status).toBe(200);
  const tokens = await response.json();
  expect(tokens.refresh_token).toBeTruthy();
  return tokens.refresh_token as string;
}

async function expectRefreshTokenResource(
  response: Response,
  resource: URL,
): Promise<string> {
  expect(response.status).toBe(200);
  const tokens = await response.json();
  expect(tokens.refresh_token).toBeTruthy();
  const authInfo = await provider.verifyAccessToken(tokens.access_token);
  expect(authInfo.resource?.toString()).toBe(resource.toString());
  return tokens.refresh_token as string;
}

async function expireRefreshToken(refreshToken: string): Promise<void> {
  const tokenKey = createHash("sha256").update(refreshToken).digest("hex");
  await storage.update<
    { tokens: Record<string, { expiresAt: number }> },
    void
  >((state) => {
    state.tokens[tokenKey]!.expiresAt = 0;
    return { state, result: undefined };
  });
}

function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

describe("OAuth SDK token-handler PKCE integration", () => {
  it("exchanges an authorization code with a valid PKCE verifier", async () => {
    const verifier = newVerifier();
    const code = await createAuthorizationCode(verifier);

    const response = await exchangeAuthorizationCode(code, verifier);

    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens).toMatchObject({ token_type: "Bearer" });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
  });

  it("returns invalid_grant for an incorrect PKCE verifier", async () => {
    const code = await createAuthorizationCode(newVerifier());

    const response = await exchangeAuthorizationCode(code, newVerifier());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("rejects a missing PKCE verifier", async () => {
    const code = await createAuthorizationCode(newVerifier());

    const response = await exchangeAuthorizationCode(code);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it("rejects reuse of an authorization code", async () => {
    const verifier = newVerifier();
    const code = await createAuthorizationCode(verifier);

    const firstResponse = await exchangeAuthorizationCode(code, verifier);
    expect(firstResponse.status).toBe(200);

    const secondResponse = await exchangeAuthorizationCode(code, verifier);
    expect(secondResponse.status).toBe(400);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("returns invalid_grant for invalid and expired refresh tokens", async () => {
    const invalidResponse = await exchangeRefreshToken(newVerifier());
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });

    const refreshToken = await createRefreshToken();
    await expireRefreshToken(refreshToken);

    const expiredResponse = await exchangeRefreshToken(refreshToken);
    expect(expiredResponse.status).toBe(400);
    await expect(expiredResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("returns invalid_scope when a refresh requests unauthorized scopes", async () => {
    const refreshToken = await createRefreshToken();

    const response = await exchangeRefreshToken(refreshToken, {
      scope: "unauthorized-scope",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_scope",
    });
  });

  it("returns invalid_target when a refresh requests a different resource", async () => {
    const refreshToken = await createRefreshToken();

    const response = await exchangeRefreshToken(refreshToken, {
      resource: "https://other-resource.example.test/mcp",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_target",
    });
  });

  it("retains the stored resource when a refresh request omits resource", async () => {
    const refreshToken = await createRefreshToken();

    const response = await exchangeRefreshToken(refreshToken);
    const rotatedRefreshToken = await expectRefreshTokenResource(
      response,
      RESOURCE_URL,
    );

    const reusedResponse = await exchangeRefreshToken(refreshToken);
    expect(reusedResponse.status).toBe(400);
    await expect(reusedResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(rotatedRefreshToken).not.toBe(refreshToken);
  });

  it("allows a matching resource and rotates the refresh token", async () => {
    const refreshToken = await createRefreshToken();

    const response = await exchangeRefreshToken(refreshToken, {
      resource: RESOURCE_URL.href,
    });
    const rotatedRefreshToken = await expectRefreshTokenResource(
      response,
      RESOURCE_URL,
    );

    expect(rotatedRefreshToken).not.toBe(refreshToken);
    const reusedResponse = await exchangeRefreshToken(refreshToken, {
      resource: RESOURCE_URL.href,
    });
    expect(reusedResponse.status).toBe(400);
    await expect(reusedResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("does not consume the refresh token after a mismatched resource", async () => {
    const refreshToken = await createRefreshToken();

    const mismatchedResponse = await exchangeRefreshToken(refreshToken, {
      resource: "https://other-resource.example.test/mcp",
    });
    expect(mismatchedResponse.status).toBe(400);
    await expect(mismatchedResponse.json()).resolves.toMatchObject({
      error: "invalid_target",
    });

    const retryResponse = await exchangeRefreshToken(refreshToken);
    const rotatedRefreshToken = await expectRefreshTokenResource(
      retryResponse,
      RESOURCE_URL,
    );
    expect(rotatedRefreshToken).not.toBe(refreshToken);
  });
});
