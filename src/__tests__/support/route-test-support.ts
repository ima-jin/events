/**
 * Shared `vi.mock` boilerplate for route tests that sit behind the events
 * app's auth entry point (`@/lib/auth`, backed by `@ima-jin/auth`'s
 * `requireSessionOrAppToken`):
 *
 *   - `@ima-jin/logger`  → one stable `mockLog` (`createLogger` + `withLogger`)
 *   - `@/lib/auth`       → `requireAuth` / `requireHardDID` / `resolveActingDid`
 *   - `@ima-jin/auth`    → `requireAppAuth` (the `x-app-did` header path)
 *   - `@ima-jin/config`  → `corsHeaders`, `getNodeSelf`, `getForestScopeConfig`
 *
 * Vitest hoists `vi.mock`/`vi.hoisted` to the top of this module, and ES
 * imports run in order, so importing this module before the route under test
 * registers every mock exactly as if it were declared inline in the test file.
 */
import { vi } from 'vitest';

export const DEFAULT_CALLER_DID = 'did:imajin:organizer';

const hoisted = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  requireAuthMock: vi.fn(),
  requireHardDIDMock: vi.fn(),
  requireAppAuthMock: vi.fn(),
  corsHeadersMock: vi.fn(),
  getNodeSelfMock: vi.fn(),
  getForestScopeConfigMock: vi.fn(),
}));

export const mockLog = hoisted.log;
export const {
  requireAuthMock,
  requireHardDIDMock,
  requireAppAuthMock,
  corsHeadersMock,
  getNodeSelfMock,
  getForestScopeConfigMock,
} = hoisted;

vi.mock('@ima-jin/logger', () => ({
  createLogger: () => hoisted.log,
  // Skip correlation-id/timing plumbing: invoke the handler directly with a
  // stable log double so warn/error calls can be asserted.
  withLogger:
    (_service: string, handler: (req: unknown, ctx: { log: typeof hoisted.log; correlationId: string }) => Promise<Response>) =>
    (req: unknown) =>
      handler(req, { log: hoisted.log, correlationId: 'cor_test' }),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: hoisted.requireAuthMock,
  requireHardDID: hoisted.requireHardDIDMock,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@ima-jin/auth', () => ({
  requireAppAuth: hoisted.requireAppAuthMock,
}));

vi.mock('@ima-jin/config', () => ({
  corsHeaders: hoisted.corsHeadersMock,
  getNodeSelf: hoisted.getNodeSelfMock,
  getForestScopeConfig: hoisted.getForestScopeConfigMock,
}));

/** The identity shape `@/lib/auth` resolves to on success. */
export function authSuccess(did: string = DEFAULT_CALLER_DID) {
  return { identity: { id: did, scopes: [], via: 'token' as const } };
}

/** The error shape `@/lib/auth` resolves to on failure. */
export function authFailure(status = 401, error = 'Unauthorized') {
  return { error, status };
}

/** Shape `requireAppAuth` resolves to on success. */
export function appAuthSuccess(userDid: string, scopes: string[] = ['events:read']) {
  return { appAuth: { appDid: 'did:imajin:app', userDid, scopes, attestationId: 'att_1' } };
}

/** Reset every mock in this module to its "authenticated happy path" default. */
export function resetRouteTestMocks(): void {
  vi.clearAllMocks();
  requireAuthMock.mockReset().mockResolvedValue(authSuccess());
  requireHardDIDMock.mockReset().mockResolvedValue(authSuccess());
  requireAppAuthMock.mockReset();
  corsHeadersMock.mockReset().mockReturnValue({});
  getNodeSelfMock.mockReset().mockResolvedValue(null);
  getForestScopeConfigMock.mockReset().mockResolvedValue(null);
}
