import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, loadHttpConfig } from "../src/config/http.js";
import { isAuthorized } from "../src/http/auth.js";

const GOOD = "a".repeat(40);

describe("loadHttpConfig", () => {
  it("applies safe defaults: localhost, port 3000, no host allow-list", () => {
    const c = loadHttpConfig({ MCP_AUTH_TOKEN: GOOD });
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(3000);
    expect(c.allowedHosts).toEqual([]);
    expect(c.authToken).toBe(GOOD);
  });

  it("refuses to start without a token (missing or blank)", () => {
    expect(() => loadHttpConfig({})).toThrow(ConfigError);
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: "   " })).toThrow(ConfigError);
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: "" })).toThrow(/required/);
  });

  it("refuses short tokens and tokens with whitespace, without echoing the token", () => {
    const weak = "short-secret-123";
    let message = "";
    try {
      loadHttpConfig({ MCP_AUTH_TOKEN: weak });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/at least 32/);
    expect(message).not.toContain(weak);
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: "a".repeat(20) + " " + "b".repeat(20) })).toThrow(/whitespace/);
  });

  it("validates the port", () => {
    for (const bad of ["0", "70000", "abc", "3.5", "-1", "3000x"]) {
      expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: GOOD, MCP_PORT: bad }), bad).toThrow(/MCP_PORT/);
    }
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: GOOD, MCP_PORT: "8080" }).port).toBe(8080);
  });

  it("parses the host allow-list (trimmed, lower-cased, empties dropped)", () => {
    const c = loadHttpConfig({ MCP_AUTH_TOKEN: GOOD, MCP_ALLOWED_HOSTS: " Abc.ngrok-free.app , ,localhost " });
    expect(c.allowedHosts).toEqual(["abc.ngrok-free.app", "localhost"]);
  });

  it("recognises loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("isAuthorized", () => {
  const token = "s3cret-".padEnd(40, "x");
  it("accepts the exact token with a Bearer scheme (case-insensitive scheme)", () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`bearer ${token}`, token)).toBe(true);
  });
  it("rejects missing, malformed, wrong-scheme, and near-miss tokens", () => {
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized("", token)).toBe(false);
    expect(isAuthorized("Bearer", token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorized(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
    expect(isAuthorized(`Bearer ${token.slice(0, -1)}y`, token)).toBe(false); // same length, wrong
    expect(isAuthorized(`Bearer ${token} extra`, token)).toBe(false);
  });
});
