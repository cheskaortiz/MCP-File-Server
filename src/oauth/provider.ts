
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthStorage } from "./storage.js";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 5 * 60;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredToken {
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  familyId: string;
}

interface OAuthState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  authorizations: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCode>;
  tokens: Record<string, StoredToken>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function cspOriginForRedirectUri(redirectUri: string): string | undefined {
  if (!URL.canParse(redirectUri)) {
    return undefined;
  }

  const redirect = new URL(redirectUri);
  if (
    (redirect.protocol !== "http:" && redirect.protocol !== "https:") ||
    redirect.username ||
    redirect.password ||
    redirect.origin === "null"
  ) {
    return undefined;
  }

  return redirect.origin;
}

function normalizeState(value: OAuthState): OAuthState {
  return {
    version: 1,
    clients: value.clients ?? {},
    authorizations: value.authorizations ?? {},
    codes: value.codes ?? {},
    tokens: value.tokens ?? {},
  };
}

export interface OAuthProviderOptions {
  storage: OAuthStorage;
  ownerPassword: string;
  issuerUrl: URL;
}

export class FileOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  private readonly diagnosticInstanceId = randomUUID();
  private readonly completedConsents = new Map<
    string,
    { decision: "allow" | "deny"; location: string; expiresAt: number }
  >();
  private readonly consentLocks = new Map<string, Promise<void>>();
  private readonly storage: OAuthStorage;
  private readonly ownerPassword: string;
  private readonly issuerUrl: URL;

  constructor(options: OAuthProviderOptions) {
    if (options.ownerPassword.length < 32) {
      throw new Error("OWNER_PASSWORD must contain at least 32 characters.");
    }

    if (options.issuerUrl.protocol !== "https:") {
      throw new Error("OAuth issuer URL must use HTTPS.");
    }

    if (
      options.issuerUrl.pathname !== "/" ||
      options.issuerUrl.search ||
      options.issuerUrl.hash
    ) {
      throw new Error("OAuth issuer URL must be an origin without a path.");
    }

    this.storage = options.storage;
    this.ownerPassword = options.ownerPassword;
    this.issuerUrl = new URL(options.issuerUrl.origin);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const state = await this.storage.read<OAuthState>();
        return state.clients?.[clientId];
      },

      registerClient: async (metadata) => {
        const client: OAuthClientInformationFull = {
          ...metadata,
          client_id: randomUUID(),
          client_id_issued_at: nowSeconds(),
        };

        await this.storage.update<OAuthState, void>((current) => {
          const state = normalizeState(current);
          state.clients[client.client_id] = client;
          return { state, result: undefined };
        });

        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const csrf = randomToken();

    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      expiresAt: nowSeconds() + PENDING_TTL_SECONDS,
    };

    await this.storage.update<OAuthState, void>((current) => {
      const state = normalizeState(current);
      state.authorizations[hash(csrf)] = pending;
      return { state, result: undefined };
    });
    console.info(
      "[oauth-lifecycle]",
      JSON.stringify({
        event: "authorization_pending_stored",
        timestamp: new Date().toISOString(),
        processId: process.pid,
        providerInstanceId: this.diagnosticInstanceId,
        pendingExists: true,
        expired: false,
      }),
    );
    const clientName = escapeHtml(client.client_name ?? "MCP client");
    const callbackOrigin = cspOriginForRedirectUri(params.redirectUri);
    const formActionSources = [
      "'self'",
      ...(callbackOrigin ? [callbackOrigin] : []),
    ].join(" ");

    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources}; base-uri 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP authorization</title>
<style>
body{font-family:system-ui,sans-serif;max-width:460px;margin:48px auto;padding:0 20px}
input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0}
button{cursor:pointer}
</style>
</head>
<body>
<h1>Authorize MCP access</h1>
<p><strong>${clientName}</strong> is requesting access to your MCP File Server.</p>
<p>Enter your owner password to approve this connection.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button name="decision" value="allow" type="submit">Approve access</button>
<button name="decision" value="deny" type="submit">Deny access</button>
</form>
</body>
</html>`);
  }

  async handleConsent(
    csrf: string,
    password: string,
    decision: string,
    res: Response,
  ): Promise<void> {
    const key = hash(csrf);
    const previous = this.consentLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.consentLocks.set(key, current);

    await previous;
    try {
      await this.processConsent(key, csrf, password, decision, res);
    } finally {
      release();
      if (this.consentLocks.get(key) === current) {
        this.consentLocks.delete(key);
      }
    }
  }

  private async processConsent(
    key: string,
    csrf: string,
    password: string,
    decision: string,
    res: Response,
  ): Promise<void> {
    const completed = this.completedConsents.get(key);
    if (completed) {
      if (completed.expiresAt <= nowSeconds()) {
        this.completedConsents.delete(key);
      } else if (decision === completed.decision) {
        console.info(
          "[oauth-lifecycle]",
          JSON.stringify({
            event: "consent_replayed",
            timestamp: new Date().toISOString(),
            processId: process.pid,
            providerInstanceId: this.diagnosticInstanceId,
          }),
        );
        if (decision === "allow" && !secureEqual(password, this.ownerPassword)) {
          res.status(401).send(
            "Incorrect owner password. Return to the MCP client and try again.",
          );
          return;
        }
        res.redirect(302, completed.location);
        return;
      }
    }

    const pending = await this.storage.update<
      OAuthState,
      PendingAuthorization | undefined
    >((current) => {
      const state = normalizeState(current);
      const entry = state.authorizations[key];
      const checkedAt = nowSeconds();
      const expired = entry ? entry.expiresAt <= checkedAt : null;

      console.info(
        "[oauth-lifecycle]",
        JSON.stringify({
          event: "consent_pending_lookup",
          timestamp: new Date().toISOString(),
          processId: process.pid,
          providerInstanceId: this.diagnosticInstanceId,
          csrfPresent: csrf.length > 0,
          pendingExists: Boolean(entry),
          expired,
        }),
      );

      if (!entry || expired) {
        delete state.authorizations[key];
        return { state, result: undefined };
      }

      if (decision === "deny") {
        delete state.authorizations[key];
        return { state, result: entry };
      }

      return { state, result: entry };
    });

    if (!pending) {
      res.status(400).send("Authorization expired or invalid. Try again.");
      return;
    }

    if (decision === "deny") {
      const target = new URL(pending.redirectUri);
      target.searchParams.set("error", "access_denied");

      if (pending.state) {
        target.searchParams.set("state", pending.state);
      }

      const location = target.toString();
      this.rememberCompletedConsent(key, decision, location);
      res.redirect(302, location);
      return;
    }

    if (decision !== "allow") {
      res.status(400).send("Invalid authorization decision.");
      return;
    }

    if (!secureEqual(password, this.ownerPassword)) {
      res.status(401).send(
        "Incorrect owner password. Return to the MCP client and try again.",
      );
      return;
    }

    const code = randomToken();
    const codeExpiresAt = nowSeconds() + CODE_TTL_SECONDS;

    await this.storage.update<OAuthState, void>((current) => {
      const state = normalizeState(current);

      state.codes[hash(code)] = {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        resource: pending.resource,
        expiresAt: codeExpiresAt,
      };

      delete state.authorizations[key];

      return { state, result: undefined };
    });

    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);

    if (pending.state) {
      target.searchParams.set("state", pending.state);
    }

    const location = target.toString();
    this.rememberCompletedConsent(key, decision, location, codeExpiresAt);
    res.redirect(302, location);
  }

  private rememberCompletedConsent(
    key: string,
    decision: "allow" | "deny",
    location: string,
    expiresAt: number = nowSeconds() + CODE_TTL_SECONDS,
  ): void {
    for (const [consentKey, consent] of this.completedConsents) {
      if (consent.expiresAt <= nowSeconds()) {
        this.completedConsents.delete(consentKey);
      }
    }

    this.completedConsents.set(key, { decision, location, expiresAt });
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const state = normalizeState(await this.storage.read<OAuthState>());
    const record = state.codes[hash(authorizationCode)];

    if (
      !record ||
      record.clientId !== client.client_id ||
      record.expiresAt <= nowSeconds()
    ) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }

    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!codeVerifier || !redirectUri) {
      throw new Error("Code verifier and redirect URI are required.");
    }

    return this.storage.update<OAuthState, OAuthTokens>((current) => {
      const state = normalizeState(current);
      const key = hash(authorizationCode);
      const record = state.codes[key];

      if (
        !record ||
        record.clientId !== client.client_id ||
        record.expiresAt <= nowSeconds() ||
        record.redirectUri !== redirectUri
      ) {
        throw new InvalidGrantError(
          "Invalid, expired, mismatched, or reused authorization code.",
        );
      }

      const calculatedChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");

      if (!secureEqual(calculatedChallenge, record.codeChallenge)) {
        throw new InvalidGrantError("PKCE verification failed.");
      }

      if (
        record.resource &&
        resource &&
        record.resource !== resource.toString()
      ) {
        throw new InvalidGrantError(
          "Resource does not match the authorization request.",
        );
      }

      delete state.codes[key];

      const tokens = this.issueTokens(
        state,
        client.client_id,
        record.scopes,
        record.resource,
      );

      return { state, result: tokens };
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.storage.update<OAuthState, OAuthTokens>((current) => {
      const state = normalizeState(current);
      const key = hash(refreshToken);
      const record = state.tokens[key];

      if (
        !record ||
        record.kind !== "refresh" ||
        record.clientId !== client.client_id ||
        record.expiresAt <= nowSeconds()
      ) {
        throw new InvalidGrantError("Invalid or expired refresh token.");
      }

      const requestedScopes = scopes ?? record.scopes;

      if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
        throw new InvalidScopeError(
          "Refresh request asks for an unauthorized scope.",
        );
      }

      if (resource && record.resource !== resource.toString()) {
        throw new InvalidTargetError(
          "Resource does not match the refresh token.",
        );
      }

      delete state.tokens[key];

      return {
        state,
        result: this.issueTokens(
          state,
          client.client_id,
          requestedScopes,
          record.resource,
          record.familyId,
        ),
      };
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const state = normalizeState(await this.storage.read<OAuthState>());
    const record = state.tokens[hash(token)];

    if (
      !record ||
      record.kind !== "access" ||
      record.expiresAt <= nowSeconds()
    ) {
      throw new InvalidTokenError("Invalid or expired access token.");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      ...(record.resource ? { resource: new URL(record.resource) } : {}),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.storage.update<OAuthState, void>((current) => {
      const state = normalizeState(current);
      const key = hash(request.token);
      const record = state.tokens[key];

      if (record && record.clientId === client.client_id) {
        delete state.tokens[key];
      }

      return { state, result: undefined };
    });
  }

  private issueTokens(
    state: OAuthState,
    clientId: string,
    scopes: string[],
    resource?: string,
    familyId: string = randomUUID(),
  ): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = nowSeconds();

    state.tokens[hash(accessToken)] = {
      kind: "access",
      clientId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TTL_SECONDS,
      familyId,
    };

    state.tokens[hash(refreshToken)] = {
      kind: "refresh",
      clientId,
      scopes,
      resource,
      expiresAt: now + REFRESH_TTL_SECONDS,
      familyId,
    };

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: scopes.join(" "),
      issuer: this.issuerUrl.origin,
    };
  }
}
