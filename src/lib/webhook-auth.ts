import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (a plain `===` / `!==` on a secret is a timing side channel). */
export function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a server-to-server `Authorization: Bearer <secret>` header against the configured
 * secret. Fails closed: with no secret configured, nothing is authorized (never a crash).
 */
export function isBearerAuthorized(authorization: string | null | undefined, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
  return secretsMatch(bearer, expectedSecret);
}
