// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImajinAuthStatus } from '@/components/ImajinAuthStatus';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ImajinAuthStatus under the production basePath', () => {
  it('reads the app session, displays the user on remount, and posts logout to the app', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      did: 'did:imajin:buyer', displayName: 'Ticket Buyer',
    })));
    vi.stubGlobal('fetch', fetch);

    const first = render(<ImajinAuthStatus />);
    expect(await screen.findByText('Ticket Buyer')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Sign in/ })).toBeNull();
    const form = screen.getByRole('button', { name: 'Sign out' }).closest('form');
    expect(form?.getAttribute('action')).toBe('/events/api/auth/logout');
    expect(form?.getAttribute('method')).toBe('POST');

    first.unmount();
    render(<ImajinAuthStatus />);
    expect(await screen.findByText('Ticket Buyer')).toBeTruthy();
    expect(fetch.mock.calls).toEqual([
      ['/events/api/auth/session'], ['/events/api/auth/session'],
    ]);
  });

  it.each(['no session', 'network failure', 'invalid JSON'])('stays signed out for %s', async (failure) => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (failure === 'network failure') throw new Error('Offline');
      return new Response(failure === 'invalid JSON' ? '<html>Not found</html>' : 'null');
    });
    vi.stubGlobal('fetch', fetch);
    render(<ImajinAuthStatus />);
    expect(await screen.findByRole('link', { name: /Sign in/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(fetch).toHaveBeenCalledWith('/events/api/auth/session');
  });

  it('keeps root-mounted development working', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    const fetch = vi.fn().mockResolvedValue(new Response('null'));
    vi.stubGlobal('fetch', fetch);
    render(<ImajinAuthStatus />);
    await screen.findByRole('link', { name: /Sign in/ });
    expect(fetch).toHaveBeenCalledWith('/api/auth/session');
  });
});
