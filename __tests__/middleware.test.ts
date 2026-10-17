import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js';

const { readKeystoreMock, resolveKeystorePathMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(),
  resolveKeystorePathMock: vi.fn(() => '/tmp/keystore.json'),
}));

vi.mock('@ima-jin/auth-client', () => ({
  readKeystore: readKeystoreMock,
  resolveKeystorePath: resolveKeystorePathMock,
}));

/** Runs the middleware for `path` with the given claim state, mocking only the on-disk keystore check. */
async function middlewareFor(path: string, options: { claimed: boolean }): Promise<NextResponse> {
  readKeystoreMock.mockReturnValue(options.claimed ? { publicKey: 'pub', privateKey: 'priv' } : null);
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(new URL(path, 'http://localhost:3000')));
}

describe('middleware', () => {
  afterEach(() => {
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
    vi.unstubAllEnvs();
  });

  it('serves the "not claimed yet" page for an ordinary route when unclaimed', async () => {
    const response = await middlewareFor('/', { claimed: false });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.toLowerCase()).toContain('not claimed yet');
  });

  it('passes /claim through when unclaimed', async () => {
    const response = await middlewareFor('/claim', { claimed: false });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes /api/health and /api/claim through when unclaimed', async () => {
    expect((await middlewareFor('/api/health', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
    expect((await middlewareFor('/api/claim', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
  });

  it('404s /claim once claimed', async () => {
    const response = await middlewareFor('/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('404s /api/claim once claimed', async () => {
    const response = await middlewareFor('/api/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('passes ordinary routes through once claimed', async () => {
    const response = await middlewareFor('/', { claimed: true });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('links to /events/claim and covers the bare basePath root', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const response = await middlewareFor('/', { claimed: false });
    expect(await response.text()).toContain('href="/events/claim"');
    const { config } = await import('../middleware');
    expect(config.runtime).toBe('nodejs');
    expect(config.matcher).toContain('/');
    expect(config.matcher).toContain('/((?!_next/static|_next/image|favicon.ico).*)');
  });

  it('checks the same configured keystore path as first boot', async () => {
    vi.stubEnv('IMAJIN_APP_KEYSTORE', '/private/events.dev.keystore.json');
    await middlewareFor('/claim', { claimed: false });
    expect(resolveKeystorePathMock).toHaveBeenCalledWith('/private/events.dev.keystore.json');
    expect(readKeystoreMock).toHaveBeenCalledWith('/tmp/keystore.json');
  });

  describe('root auth callbacks under /events', () => {
    function callbackRequest(path: string): NextRequest {
      return new NextRequest(new URL(path, 'http://localhost:3000'), {
        nextConfig: { basePath: '/events' },
      });
    }

    it.each([false, true])('forwards both parameters before checking claim state (claimed=%s)', async (claimed) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://events.test/events');
      vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
      readKeystoreMock.mockReturnValue(claimed ? { publicKey: 'pub' } : null);
      const { middleware, config } = await import('../middleware');
      const query = '?attestation_id=att%2F123&user_did=did%3Aimajin%3Aoperator';

      for (const root of ['/events', '/events/']) {
        const request = callbackRequest(`${root}${query}`);
        expect(unstable_doesMiddlewareMatch({
          config,
          nextConfig: { basePath: '/events' },
          url: request.url,
        })).toBe(true);
        expect(request.nextUrl.pathname).toBe('/');
        const response = middleware(request);
        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(`https://events.test/events/api/auth/callback${query}`);
      }
      expect(readKeystoreMock).not.toHaveBeenCalled();
    });

    it.each(['', '?attestation_id=att-123', '?user_did=did:imajin:operator'])(
      'keeps existing gates for missing or partial callback parameters: %s',
      async (query) => {
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://events.test/events');
        vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
        const { middleware } = await import('../middleware');
        readKeystoreMock.mockReturnValue(null);
        const unclaimed = middleware(callbackRequest(`/events/${query}`));
        expect(unclaimed.status).toBe(200);
        expect(unclaimed.headers.get('location')).toBeNull();
        expect(await unclaimed.text()).toContain('href="/events/claim"');

        readKeystoreMock.mockReturnValue({ publicKey: 'pub' });
        const claimed = middleware(callbackRequest(`/events/${query}`));
        expect(claimed.headers.get('x-middleware-next')).toBe('1');
        expect(claimed.headers.get('location')).toBeNull();
      },
    );

    it('leaves non-root callbacks alone and keeps the callback handler reachable after claim', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://events.test/events');
      vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
      readKeystoreMock.mockReturnValue({ publicKey: 'pub' });
      const { middleware, config } = await import('../middleware');
      for (const path of ['/events/api/auth/callback', '/events/dashboard']) {
        const request = callbackRequest(`${path}?attestation_id=att-123&user_did=did:imajin:operator`);
        expect(unstable_doesMiddlewareMatch({
          config,
          nextConfig: { basePath: '/events' },
          url: request.url,
        })).toBe(true);
        expect(middleware(request).headers.get('x-middleware-next')).toBe('1');
      }
    });
  });
});
