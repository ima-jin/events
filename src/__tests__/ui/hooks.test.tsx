// @vitest-environment jsdom
/** Tests for the ticket purchase hooks (src/components/tickets/hooks.ts). */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutError } from '@/components/tickets/checkout-api';
import { resolveRails, useBalanceCents, useCart, useCheckout } from '@/components/tickets/hooks';
import { FREE_TIER, jsonResponse, makeTier, mockFetch } from '../support/ui-support';

describe('useCart', () => {
  const general = makeTier();
  const vip = makeTier({ id: 'tier_vip', name: 'VIP', price: 5000 });

  it('totals the paid lines and ignores free tiers', () => {
    const { result } = renderHook(() => useCart([general, vip, FREE_TIER], null));

    act(() => {
      result.current.setQuantity(general, 2);
      result.current.setQuantity(vip, 1);
      result.current.setQuantity(FREE_TIER, 3);
    });

    expect(result.current.lines).toEqual([
      { ticketTypeId: 'tier_general', quantity: 2 },
      { ticketTypeId: 'tier_vip', quantity: 1 },
    ]);
    expect(result.current.totalCents).toBe(9000);
    expect(result.current.currency).toBe('CAD');
  });

  it('clamps quantities to 0..max', () => {
    const { result } = renderHook(() => useCart([general], 3));

    act(() => result.current.setQuantity(general, 99));
    expect(result.current.quantities[general.id]).toBe(3);
    act(() => result.current.setQuantity(general, -4));
    expect(result.current.quantities[general.id]).toBe(0);
    expect(result.current.lines).toEqual([]);
  });

  it('falls back to CAD with no tiers at all', () => {
    const { result } = renderHook(() => useCart([], null));

    expect(result.current.currency).toBe('CAD');
    expect(result.current.totalCents).toBe(0);
  });
});

describe('useCheckout', () => {
  it('finishes with the result of a successful task', async () => {
    const { result } = renderHook(() => useCheckout());

    let failure: CheckoutError | null = new CheckoutError('stale', 0);
    await act(async () => {
      failure = await result.current.run(async () => ({ kind: 'free' }));
    });

    expect(failure).toBeNull();
    expect(result.current.state).toMatchObject({ status: 'done', result: { kind: 'free' }, error: null });
  });

  it('records a failure and returns it', async () => {
    const { result } = renderHook(() => useCheckout());

    let failure: CheckoutError | null = null;
    await act(async () => {
      failure = await result.current.run(() => Promise.reject(new CheckoutError('Sold out', 409)));
    });

    expect(failure).toMatchObject({ message: 'Sold out', status: 409 });
    expect(result.current.state).toMatchObject({ status: 'idle', error: 'Sold out', noCardRail: false });
  });

  it('wraps non-checkout errors and non-Error rejections', async () => {
    const { result } = renderHook(() => useCheckout());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('network down')));
    });
    expect(result.current.state.error).toBe('network down');

    await act(async () => {
      await result.current.run(() => Promise.reject('weird'));
    });
    expect(result.current.state.error).toBe('Something went wrong');
  });

  it('remembers SELLER_NO_CARD_RAIL (without a raw error) across later attempts', async () => {
    const { result } = renderHook(() => useCheckout());

    await act(async () => {
      await result.current.run(() => Promise.reject(new CheckoutError('no rail', 409, 'SELLER_NO_CARD_RAIL')));
    });
    expect(result.current.state).toMatchObject({ noCardRail: true, error: null });

    await act(async () => {
      await result.current.run(() => Promise.reject(new CheckoutError('other', 500)));
    });
    expect(result.current.state).toMatchObject({ noCardRail: true, error: 'other' });
  });

  it('navigates on a redirect result and stays busy', async () => {
    const { result } = renderHook(() => useCheckout());

    await act(async () => {
      await result.current.run(async () => ({ kind: 'redirect', url: '#to-provider' }));
    });

    expect(globalThis.location.hash).toBe('#to-provider');
    expect(result.current.state.status).toBe('busy');
  });
});

describe('useBalanceCents', () => {
  it('stays null and makes no request while disabled', () => {
    const fetchSpy = mockFetch({});

    const { result } = renderHook(() => useBalanceCents(false));

    expect(result.current).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads the balance in cents when enabled', async () => {
    mockFetch({ '/api/balance': jsonResponse({ balance: 7.5 }) });

    const { result } = renderHook(() => useBalanceCents(true));

    await waitFor(() => expect(result.current).toBe(750));
  });

  it('ignores a response that arrives after unmount', async () => {
    let release: (response: Response) => void = () => undefined;
    mockFetch({ '/api/balance': () => new Promise<Response>((resolve) => { release = resolve; }) });
    const { result, unmount } = renderHook(() => useBalanceCents(true));

    unmount();
    release(jsonResponse({ balance: 9 }));
    await vi.waitFor(() => expect(result.current).toBeNull());
  });
});

describe('resolveRails', () => {
  const base = { etransferEnabled: false, noCardRail: false, balanceCents: null, totalCents: 2000 };

  it('offers card by default and hides it once the seller has no card rail', () => {
    expect(resolveRails(base)).toEqual({ card: true, balance: false, etransfer: false });
    expect(resolveRails({ ...base, noCardRail: true }).card).toBe(false);
  });

  it('offers balance only when it covers the total, and e-Transfer when enabled', () => {
    expect(resolveRails({ ...base, balanceCents: 1999 }).balance).toBe(false);
    expect(resolveRails({ ...base, balanceCents: 2000 }).balance).toBe(true);
    expect(resolveRails({ ...base, etransferEnabled: true }).etransfer).toBe(true);
  });
});
