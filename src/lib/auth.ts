import { requireSessionOrAppToken } from '@ima-jin/auth';
import { getIdentityTier } from '@/lib/kernel';

/**
 * The events app's single auth entry point (refs ima-jin/imajin-ai#1974).
 *
 * Every route authenticates through `requireSessionOrAppToken` from the
 * published `@ima-jin/auth` SDK: a scoped app token (`Authorization: Bearer`,
 * preferred) minted for THIS app's host, or the legacy session cookie as the
 * migration fallback. No kernel-internal auth helper is imported.
 *
 * Scopes are only enforceable on the token path — the cookie path predates
 * scoped grants and always carries `scopes: []`.
 */

export const EVENTS_READ_SCOPE = 'events:read';
export const EVENTS_WRITE_SCOPE = 'events:write';

export interface EventsIdentity {
  /** DID of the authenticated caller (the token's `sub`, or the session's DID). */
  id: string;
  /** Identity tier — only populated by {@link requireHardDID}. */
  tier?: string;
  /** Scopes granted to this call. Always empty on the cookie path. */
  scopes: string[];
  via: 'token' | 'cookie';
}

export interface AuthError {
  error: string;
  status: number;
}

export interface AuthSuccess {
  identity: EventsIdentity;
}

export interface RequireAuthOptions {
  /** Scopes that must all be present on the token path. Defaults by HTTP method. */
  scopes?: string[];
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** This app's own host — the `aud` every accepted token must be scoped to. */
export function appAudience(): string {
  const explicit = process.env.IMAJIN_APP_AUDIENCE;
  if (explicit) return explicit;
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!publicUrl) {
    throw new Error('Set IMAJIN_APP_AUDIENCE or NEXT_PUBLIC_APP_URL — see .env.example.');
  }
  return new URL(publicUrl).host;
}

/** `events:read` for safe methods, `events:write` for everything else. */
export function defaultScopesFor(request: Request): string[] {
  return [READ_METHODS.has(request.method.toUpperCase()) ? EVENTS_READ_SCOPE : EVENTS_WRITE_SCOPE];
}

/**
 * Authenticate the caller via scoped app token or session cookie.
 * Returns `{ identity }` on success, `{ error, status }` otherwise.
 */
export async function requireAuth(
  request: Request,
  options: RequireAuthOptions = {}
): Promise<AuthSuccess | AuthError> {
  const result = await requireSessionOrAppToken(request, {
    aud: appAudience(),
    requireScopes: options.scopes ?? defaultScopesFor(request),
  });

  if ('error' in result) {
    return { error: result.error, status: result.status };
  }

  const { did, scopes, via } = result.auth;
  return { identity: { id: did, scopes, via } };
}

/** Like {@link requireAuth}, but resolves to `null` instead of an error. */
export async function optionalAuth(
  request: Request,
  options: RequireAuthOptions = {}
): Promise<EventsIdentity | null> {
  const result = await requireAuth(request, options);
  return 'error' in result ? null : result.identity;
}

/**
 * The DID a request acts as. The app-token contract carries no delegation
 * overlay (act-as / acting-for), so this is always the caller's own DID.
 */
export function resolveActingDid(identity: EventsIdentity): string {
  return identity.id;
}

/** Standard JSON-able body for an {@link AuthError}. */
export function authErrorBody(authError: AuthError): { error: string } {
  return { error: authError.error };
}

/** DIDs allowed to use platform-admin routes: `NODE_DID` plus `EVENTS_ADMIN_DIDS` (comma-separated). */
function adminDids(): Set<string> {
  const dids = (process.env.EVENTS_ADMIN_DIDS ?? '').split(',').map((d) => d.trim());
  if (process.env.NODE_DID) dids.push(process.env.NODE_DID);
  return new Set(dids.filter(Boolean));
}

/**
 * Authenticate the caller and require them to be a platform admin. The kernel
 * version compared the session's act-as DID with `NODE_DID`; act-as is not part
 * of the app-token contract, so admins are listed explicitly instead.
 */
export async function requireAdmin(request: Request): Promise<AuthSuccess | AuthError> {
  const result = await requireAuth(request);
  if ('error' in result) return result;
  if (!adminDids().has(result.identity.id)) {
    return { error: 'Admin access required', status: 403 };
  }
  return result;
}

/**
 * Authenticate the caller and require a full ("hard") identity — soft
 * (email-only) DIDs are rejected. The tier comes from the kernel's public
 * registry resolver; an unresolvable tier is treated as soft (fail closed).
 */
export async function requireHardDID(request: Request): Promise<AuthSuccess | AuthError> {
  const result = await requireAuth(request);
  if ('error' in result) return result;

  const tier = await getIdentityTier(result.identity.id);
  if (!tier || tier === 'soft') {
    return { error: 'This action requires a full identity (hard DID)', status: 403 };
  }
  return { identity: { ...result.identity, tier } };
}
