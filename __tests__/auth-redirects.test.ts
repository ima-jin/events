import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { verifySessionToken } from '@ima-jin/auth-client';

// Model an already vault-loaded session secret; never provision keys or call a live kernel.
vi.mock('@/lib/self-secrets', () => ({
  getSelfSecret: vi.fn(() => 'test-only-vault-session-value'),
}));

const publicUrl = 'https://events.test/events';
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
    vi.stubEnv('NEXT_PUBLIC_APP_URL', publicUrl);
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.test');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:events');
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
    const cookie = response.cookies.get('imajin_session');
    expect(cookie).toBeDefined();
    expect(await verifySessionToken(cookie!.value, authConfig)).toMatchObject({
      did: userDid,
      attestationId,
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
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
    expect(response.cookies.get('imajin_session')).toBeUndefined();
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
    expect(response.cookies.get('imajin_session')?.value).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
