// @vitest-environment jsdom
/** Tests for the browser-side checkout calls (src/components/tickets/checkout-api.ts). */
import { describe, expect, it, vi } from 'vitest';
import {
  CheckoutError,
  fetchBalanceCents,
  isNoCardRail,
  reserveEtransfer,
  rsvpFree,
  startBalanceCheckout,
  startCardCheckout,
  unlockTiers,
} from '@/components/tickets/checkout-api';
import { EVENT_ID, jsonResponse, makeTierRow, mockFetch, requestBody } from '../support/ui-support';

const ITEMS = [{ ticketTypeId: 'tier_general', quantity: 2 }];

describe('card + balance checkout', () => {
  it('POSTs the cart (and invite) to /api/checkout and returns the redirect URL', async () => {
    const fetchSpy = mockFetch({ '/api/checkout': jsonResponse({ url: 'https://pay.example/session' }) });

    const result = await startCardCheckout(EVENT_ID, ITEMS, 'INV1');

    expect(result).toEqual({ kind: 'redirect', url: 'https://pay.example/session' });
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/checkout');
    expect(requestBody(fetchSpy, '/api/checkout')).toEqual({ eventId: EVENT_ID, items: ITEMS, invite: 'INV1' });
  });

  it('omits the invite when there is none', async () => {
    const fetchSpy = mockFetch({ '/api/checkout': jsonResponse({ url: 'u' }) });

    await startCardCheckout(EVENT_ID, ITEMS);

    expect(requestBody(fetchSpy, '/api/checkout')).not.toHaveProperty('invite');
  });

  it('surfaces SELLER_NO_CARD_RAIL (409) as a recognisable error', async () => {
    mockFetch({ '/api/checkout': jsonResponse({ error: 'no rail', code: 'SELLER_NO_CARD_RAIL' }, 409) });

    const failure = await startCardCheckout(EVENT_ID, ITEMS).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(CheckoutError);
    expect(isNoCardRail(failure)).toBe(true);
    expect((failure as CheckoutError).message).toBe('no rail');
  });

  it('does not mistake other 409s or other codes for a missing card rail', async () => {
    mockFetch({ '/api/checkout': jsonResponse({ error: 'Only 1 General ticket available' }, 409) });

    const failure = await startCardCheckout(EVENT_ID, ITEMS).catch((e: unknown) => e);

    expect(isNoCardRail(failure)).toBe(false);
    expect(isNoCardRail(new Error('x'))).toBe(false);
    expect(isNoCardRail(new CheckoutError('x', 400, 'SELLER_NO_CARD_RAIL'))).toBe(false);
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    mockFetch({ '/api/checkout': new Response('boom', { status: 500 }) });

    await expect(startCardCheckout(EVENT_ID, ITEMS)).rejects.toThrow('Failed to create checkout');
  });

  it('balance checkout returns the order id', async () => {
    mockFetch({ '/api/checkout/balance': jsonResponse({ success: true, orderId: 'ord_9' }) });

    expect(await startBalanceCheckout(EVENT_ID, ITEMS)).toEqual({ kind: 'balance', orderId: 'ord_9' });
  });

  it('balance checkout reports the server error', async () => {
    mockFetch({ '/api/checkout/balance': jsonResponse({ error: 'Insufficient balance' }, 402) });

    await expect(startBalanceCheckout(EVENT_ID, ITEMS)).rejects.toThrow('Insufficient balance');
  });
});

describe('reserveEtransfer', () => {
  it('returns the payment instructions with the order id and trims buyer details', async () => {
    const instructions = { email: 'pay@org.ca', amount: 40, currency: 'CAD', memo: 'ORD-1', deadline: '2030-01-01T00:00:00Z', message: 'Send it' };
    const fetchSpy = mockFetch({ '/api/checkout/etransfer': jsonResponse({ orderId: 'ord_1', instructions }, 201) });

    const result = await reserveEtransfer(EVENT_ID, ITEMS, { email: ' a@b.co ', name: ' Ann ' });

    expect(result).toEqual({ kind: 'etransfer', instructions: { ...instructions, orderId: 'ord_1' } });
    expect(requestBody(fetchSpy, '/api/checkout/etransfer')).toMatchObject({ email: 'a@b.co', name: 'Ann', items: ITEMS });
  });

  it('returns the verification notice for anonymous buyers', async () => {
    mockFetch({ '/api/checkout/etransfer': jsonResponse({ verificationSent: true, message: 'We sent a link' }) });

    expect(await reserveEtransfer(EVENT_ID, ITEMS, { email: 'a@b.co' })).toEqual({ kind: 'verification', message: 'We sent a link' });
  });

  it('uses a default verification message when the server sends none', async () => {
    mockFetch({ '/api/checkout/etransfer': jsonResponse({ verificationSent: true }) });

    const result = await reserveEtransfer(EVENT_ID, ITEMS, {});

    expect(result).toMatchObject({ kind: 'verification', message: expect.stringContaining('email') });
  });

  it('reports e-Transfer failures', async () => {
    mockFetch({ '/api/checkout/etransfer': jsonResponse({ error: 'e-Transfer is not available for this event' }, 400) });

    await expect(reserveEtransfer(EVENT_ID, ITEMS, {})).rejects.toThrow('e-Transfer is not available');
  });
});

describe('rsvpFree', () => {
  it('RSVPs a single tier', async () => {
    const fetchSpy = mockFetch({ '/api/checkout/free': jsonResponse({ success: true, ticketId: 't1' }) });

    expect(await rsvpFree(EVENT_ID, 'tier_free', { email: 'a@b.co' }, 'INV')).toEqual({ kind: 'free' });
    expect(requestBody(fetchSpy, '/api/checkout/free')).toEqual({ eventId: EVENT_ID, ticketTypeId: 'tier_free', invite: 'INV', email: 'a@b.co' });
  });

  it('treats "you already have a ticket" (409) as success', async () => {
    mockFetch({ '/api/checkout/free': jsonResponse({ error: 'You already have a ticket for this event' }, 409) });

    expect(await rsvpFree(EVENT_ID, 'tier_free', {})).toEqual({ kind: 'free' });
  });

  it('rethrows other failures, keeping the status', async () => {
    mockFetch({ '/api/checkout/free': jsonResponse({ error: 'Please provide an email address to RSVP' }, 400) });

    const failure = (await rsvpFree(EVENT_ID, 'tier_free', {}).catch((e: unknown) => e)) as CheckoutError;

    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/email/);
  });
});

describe('unlockTiers / fetchBalanceCents', () => {
  it('maps unlocked tiers through the public allow-list', async () => {
    const fetchSpy = mockFetch({ '/tiers/unlock': jsonResponse({ tiers: [makeTierRow({ id: 'vip', accessCode: 'VIP', sold: 1 })] }) });

    const tiers = await unlockTiers(EVENT_ID, 'a b');

    expect(fetchSpy.mock.calls[0][0]).toBe(`/api/events/${EVENT_ID}/tiers/unlock?code=a%20b`);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).not.toHaveProperty('accessCode');
  });

  it('reports an invalid code', async () => {
    mockFetch({ '/tiers/unlock': jsonResponse({ error: 'Invalid access code' }, 404) });

    await expect(unlockTiers(EVENT_ID, 'nope')).rejects.toThrow('Invalid access code');
  });

  it('converts the dollar balance to cents', async () => {
    mockFetch({ '/api/balance': jsonResponse({ balance: 12.34, currency: 'CAD' }) });

    expect(await fetchBalanceCents()).toBe(1234);
  });

  it.each([
    ['an unavailable pay service', jsonResponse({ balance: 0, unavailable: true }, 502)],
    ['a flagged 200', jsonResponse({ balance: 5, unavailable: true })],
    ['a malformed body', jsonResponse({ nope: true })],
  ])('returns null for %s', async (_label, response) => {
    mockFetch({ '/api/balance': response });

    expect(await fetchBalanceCents()).toBeNull();
  });

  it('returns null when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await fetchBalanceCents()).toBeNull();
  });
});
