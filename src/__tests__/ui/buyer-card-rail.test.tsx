// @vitest-environment jsdom
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBuyerCardRail } from '@/components/tickets/use-buyer-card-rail';
import { FREE_TIER, deferredResponse, jsonResponse, makeTierRow, mockFetch, renderPurchase } from '../support/ui-support';

const CHECK_URL = 'https://kernel.test/pay/api/card-rail/check?did=did%3Aimajin%3Ahost';
const CHECK_PATH = '/card-rail/check';
const CARD_BUTTON = { name: 'Pay with Card' };
const EMT_BUTTON = { name: 'Pay by e-Transfer' };

describe('buyer card readiness', () => {
  it.each([true, false])('uses only a boolean cardEnabled (%s)', async (cardEnabled) => {
    const fetch = mockFetch({ [CHECK_PATH]: jsonResponse({ cardEnabled }) });
    const { result, rerender } = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    expect(result.current).toBe('checking');
    await waitFor(() => expect(result.current).toBe(cardEnabled ? 'ready' : 'missing'));
    rerender();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(CHECK_URL, {
      cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
    });
  });

  it.each([{}, null, { cardEnabled: 'true' }])('treats malformed readiness %j as unavailable', async (body) => {
    mockFetch({ [CHECK_PATH]: jsonResponse(body) });
    const { result } = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    await waitFor(() => expect(result.current).toBe('unavailable'));
  });

  it.each([429, 500])('treats HTTP %s as unavailable', async (status) => {
    mockFetch({ [CHECK_PATH]: jsonResponse({ error: 'Unavailable' }, status) });
    const { result } = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    await waitFor(() => expect(result.current).toBe('unavailable'));
  });

  it('handles network and JSON failures without offering cards', async () => {
    mockFetch({ [CHECK_PATH]: () => Promise.reject(new Error('offline')) });
    const { result, unmount } = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    await waitFor(() => expect(result.current).toBe('unavailable'));
    unmount();
    mockFetch({ [CHECK_PATH]: new Response('invalid json') });
    const second = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    await waitFor(() => expect(second.result.current).toBe('unavailable'));
  });

  it('does not call the kernel for free-only tiers or missing configuration', () => {
    const fetch = mockFetch({});
    renderHook(() => useBuyerCardRail(CHECK_URL, false));
    const { result } = renderHook(() => useBuyerCardRail(null, true));
    expect(result.current).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards an old URL response and aborts on unmount', async () => {
    const pending = deferredResponse();
    const fetch = mockFetch({ [CHECK_PATH]: () => pending.promise });
    const { result, rerender, unmount } = renderHook(({ url }) => useBuyerCardRail(url, true), {
      initialProps: { url: CHECK_URL },
    });
    const signal = fetch.mock.calls[0][1]?.signal;
    rerender({ url: `${CHECK_URL}2` });
    expect(signal?.aborted).toBe(true);
    expect(result.current).toBe('checking');
    unmount();
    await act(async () => pending.resolve(jsonResponse({ cardEnabled: true })));
    expect(result.current).toBe('checking');
  });

  it('bounds network waiting to five seconds', async () => {
    vi.useFakeTimers();
    mockFetch({ [CHECK_PATH]: (init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    const { result } = renderHook(() => useBuyerCardRail(CHECK_URL, true));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current).toBe('unavailable');
  });
});

describe('buyer card visibility', () => {
  it('hides cards for an e-Transfer-only host before any failed checkout, without rechecking quantity changes', async () => {
    const fetch = mockFetch({ [CHECK_PATH]: jsonResponse({ cardEnabled: false }) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await user.click(screen.getByRole('button', { name: 'Add one General' }));
    expect(await screen.findByText(/card payment isn't set up/i)).toBeTruthy();
    expect(screen.queryByRole('button', CARD_BUTTON)).toBeNull();
    expect(screen.getByRole('button', EMT_BUTTON)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add one General' }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('hides card while checking and shows it only after affirmative readiness', async () => {
    const pending = deferredResponse();
    mockFetch({ [CHECK_PATH]: () => pending.promise });
    const { user } = renderPurchase({ etransferEnabled: true });
    await user.click(screen.getByRole('button', { name: 'Add one General' }));
    expect(screen.queryByRole('button', CARD_BUTTON)).toBeNull();
    expect(screen.getByText('Checking card payment availability…')).toBeTruthy();
    expect(screen.getByRole('button', EMT_BUTTON)).toBeTruthy();
    await act(async () => pending.resolve(jsonResponse({ cardEnabled: true })));
    expect(screen.getByRole('button', CARD_BUTTON)).toBeTruthy();
  });

  it('keeps e-Transfer and explains how to retry when readiness is unavailable', async () => {
    mockFetch({ [CHECK_PATH]: jsonResponse({}, 503) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await user.click(screen.getByRole('button', { name: 'Add one General' }));
    expect(await screen.findByText(/Reload to try again/)).toBeTruthy();
    expect(screen.queryByRole('button', CARD_BUTTON)).toBeNull();
    expect(screen.getByRole('button', EMT_BUTTON)).toBeTruthy();
  });

  it('leaves free RSVP alone and checks only when a paid hidden tier is unlocked', async () => {
    const fetch = mockFetch({ '/tiers/unlock': jsonResponse({ tiers: [makeTierRow({ id: 'paid', name: 'Paid' })] }) });
    const { user } = renderPurchase({ tiers: [FREE_TIER], hasHiddenTiers: true });
    expect(screen.getByRole('button', { name: 'RSVP for Community' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Have an access code?'), 'paid');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes(CHECK_PATH))).toBe(true));
  });
});
