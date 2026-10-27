import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createSessionToken, getSession, sessionCookieName, verifySessionToken } from '@ima-jin/auth-client';
import { getSelfSecret } from '@/lib/self-secrets';

const { cookieStore, readCookie } = vi.hoisted(() => {
  const cookieStore = new Map<string, { value: string }>();
  return { cookieStore, readCookie: vi.fn((name: string) => cookieStore.get(name)) };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: readCookie }),
}));

// Model an already vault-loaded session secret; never provision keys or call a live kernel.
vi.mock('@/lib/self-secrets', () => ({
  getSelfSecret: vi.fn(() => 'test-only-vault-session-value'),
}));

const publicUrl = 'https://events.test/events';
const appDid = 'did:imajin:events';
const appCookieName = `imajin_app_session_${createHash('sha256').update(appDid).digest('hex')}`;
const otherAppCookieName = `imajin_app_session_${createHash('sha256').update('did:imajin:coffee').digest('hex')}`;
const userDid = 'did:imajin:operator';
const attestationId = 'att/operator-123';
const callbackQuery = new URLSearchParams({ attestation_id: attestationId, user_did: userDid });

function authRequest(path: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3000/events/api/auth/${path}`, {
    method,
    nextConfig: { basePath: '/events' },
  });
}

describe('published SDK auth route redirects', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cookieStore.clear();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', publicUrl);
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.test');
    vi.stubEnv('IMAJIN_APP_DID', appDid);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('consumes a valid attestation callback, sets a verifiable session and lands in events without restarting login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      did: userDid,
      displayName: 'Operator',
      handle: 'operator',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('../app/api/auth/callback/route');
    const { authConfig } = await import('@/lib/auth-config');
    const response = await GET(authRequest(`callback?${callbackQuery}`));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://kernel.test/profile/api/profile/${encodeURIComponent(userDid)}`,
      { headers: { 'Content-Type': 'application/json' } },
    );
    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get('location')!);
    expect(destination.origin).toBe(new URL(publicUrl).origin);
    expect(destination.pathname).toBe('/events/');
    expect(destination.search).toBe('');
    expect(destination.href).not.toBe(`${publicUrl}/?${callbackQuery}`);
    expect(authConfig.cookieName).toBeUndefined();
    expect(sessionCookieName(authConfig)).toBe(appCookieName);
    expect(response.cookies.getAll().map(({ name }) => name)).toEqual([appCookieName]);
    const cookie = response.cookies.get(appCookieName);
    expect(cookie).toBeDefined();
    expect(await verifySessionToken(cookie!.value, authConfig)).toMatchObject({
      did: userDid,
      attestationId,
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.cookies.get(appCookieName)).toMatchObject({ path: '/', sameSite: 'lax' });
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');

    cookieStore.set(appCookieName, { value: cookie!.value });
    const { GET: session } = await import('../app/api/auth/session/route');
    expect(await (await session()).json()).toMatchObject({ did: userDid, attestationId });
    expect(await getSession(authConfig)).toMatchObject({ did: userDid, attestationId });
    expect(readCookie.mock.calls).toEqual([[appCookieName], [appCookieName]]);
  });

  it.each(['', '?attestation_id=att-123', '?user_did=did:imajin:operator'])(
    'keeps missing-parameter auth errors in events: %s',
    async (query) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('../app/api/auth/callback/route');
      const response = await GET(authRequest(`callback${query}`));
      expect(response.headers.get('location')).toBe(`${publicUrl}/?auth_error=missing_params`);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 403, error: 'attestation_revoked' },
    { status: 500, error: 'profile_fetch_failed' },
  ])('keeps $error in events', async ({ status, error }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(authRequest(`callback?${callbackQuery}`));
    expect(response.headers.get('location')).toBe(`${publicUrl}/?auth_error=${error}`);
    expect(response.cookies.getAll()).toEqual([]);
  });

  it('keeps network auth errors in events', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(authRequest(`callback?${callbackQuery}`));
    expect(response.headers.get('location')).toBe(`${publicUrl}/?auth_error=network_error`);
  });

  it('clears the session and returns logout to events, not the kernel root', async () => {
    const { POST } = await import('../app/api/auth/logout/route');
    const response = await POST(authRequest('logout', 'POST'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${publicUrl}/`);
    expect(response.cookies.getAll().map(({ name }) => name)).toEqual([appCookieName]);
    expect(response.cookies.get(appCookieName)?.value).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it.each(['imajin_session', otherAppCookieName])(
    'does not read or migrate %s into an events session',
    async (name) => {
      const { authConfig } = await import('@/lib/auth-config');
      // Even a token verifiable with this app's key is ignored under another cookie name.
      const token = await createSessionToken({
        did: userDid, displayName: 'Operator', handle: 'operator', attestationId,
      }, authConfig);
      cookieStore.set(name, { value: token });
      const { GET } = await import('../app/api/auth/session/route');
      const response = await GET();
      expect(await response.json()).toBeNull();
      expect(await getSession(authConfig)).toBeNull();
      expect(readCookie.mock.calls).toEqual([[appCookieName], [appCookieName]]);
      expect(response.cookies.getAll()).toEqual([]);
      expect(cookieStore.get(name)?.value).toBe(token);
    },
  );

  it('rejects an invalid app token without touching other sessions', async () => {
    cookieStore.set(appCookieName, { value: 'not-a-session-token' });
    const { GET } = await import('../app/api/auth/session/route');
    const response = await GET();
    expect(await response.json()).toBeNull();
    expect(response.cookies.getAll()).toEqual([]);
    expect(readCookie.mock.calls).toEqual([[appCookieName]]);
  });

  it('derives a distinct cookie for another app on the same host', async () => {
    const { authConfig } = await import('@/lib/auth-config');
    expect(sessionCookieName({ ...authConfig, appDid: 'did:imajin:coffee' })).toBe(otherAppCookieName);
    expect(otherAppCookieName).not.toBe(appCookieName);
    expect(appCookieName).not.toBe('imajin_session');
  });

  it('imports handlers without app identity or vault secrets, then fails closed per request', async () => {
    vi.stubEnv('IMAJIN_APP_DID', undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET: callback } = await import('../app/api/auth/callback/route');
    const { GET: session } = await import('../app/api/auth/session/route');
    const { POST: logout } = await import('../app/api/auth/logout/route');
    expect(getSelfSecret).not.toHaveBeenCalled();

    await expect(callback(authRequest(`callback?${callbackQuery}`))).rejects.toThrow('appDid is required');
    await expect(session()).rejects.toThrow('appDid is required');
    await expect(logout(authRequest('logout', 'POST'))).rejects.toThrow('appDid is required');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCookie).not.toHaveBeenCalled();
    expect(getSelfSecret).not.toHaveBeenCalled();
  });

  it('refuses a kernel-cookie override before any auth side effects', async () => {
    const { createCallbackHandler, createSessionHandler, createLogoutHandler } = await import('@ima-jin/auth-client');
    const { authConfig } = await import('@/lib/auth-config');
    const reservedConfig = { ...authConfig, cookieName: 'imajin_session' };
    vi.clearAllMocks();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCallbackHandler(reservedConfig)(authRequest(`callback?${callbackQuery}`)))
      .rejects.toThrow('reserved for the kernel');
    await expect(createSessionHandler(reservedConfig)()).rejects.toThrow('reserved for the kernel');
    await expect(createLogoutHandler(reservedConfig)(authRequest('logout', 'POST')))
      .rejects.toThrow('reserved for the kernel');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCookie).not.toHaveBeenCalled();
  });
});
