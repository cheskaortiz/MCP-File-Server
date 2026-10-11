import crypto from "node:crypto";

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * Validates an `Authorization: Bearer <token>` header. Both sides are hashed to a fixed
 * length first, so the comparison is constant-time and does not leak the token length.
 * The scheme name is case-insensitive (RFC 9110).
 */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader) return false;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(authorizationHeader.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;
  return crypto.timingSafeEqual(digest(presented), digest(expectedToken));
}
