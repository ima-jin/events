// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClaimPage from '../page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function submitCode() {
  render(<ClaimPage />);
  fireEvent.change(screen.getByLabelText('Claim code'), { target: { value: 'operator-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Claim app' }));
}

describe('operator claim page', () => {
  it('posts to /events/api/claim and shows only public identity after success', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      appDid: 'did:imajin:events', publicKey: 'public-key',
    })));
    vi.stubGlobal('fetch', fetchMock);
    submitCode();
    expect(await screen.findByRole('heading', { name: 'App claimed' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/events/api/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: 'operator-code' }),
    });
    expect(screen.getByText('did:imajin:events')).toBeTruthy();
    expect(screen.getByText('public-key')).toBeTruthy();
    expect(screen.queryByText('operator-code')).toBeNull();
  });

  it('accepts a success without a public key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ appDid: 'did:imajin:events' }))));
    submitCode();
    expect(await screen.findByRole('heading', { name: 'App claimed' })).toBeTruthy();
    expect(screen.queryByText('Public key')).toBeNull();
  });

  it.each([
    [JSON.stringify({ error: 'Unable to redeem this claim code' }), 400, 'Unable to redeem this claim code'],
    [JSON.stringify({}), 200, 'Unable to claim this app'],
    ['not-json', 400, 'Unable to claim this app'],
  ])('shows an actionable error for response %s', async (body, status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
    submitCode();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('shows a network error and permits retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    submitCode();
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach this app — try again');
    expect((screen.getByRole('button', { name: 'Claim app' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the submit button during the exchange', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    submitCode();
    expect((screen.getByRole('button', { name: 'Claiming…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
