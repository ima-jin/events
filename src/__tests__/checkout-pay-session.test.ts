/**
 * Tests for requestPayCheckoutSession (src/lib/checkout-helpers.ts): the pay /api/checkout call, and how
 * events surfaces a seller with no card rail (Stripe Connect is retired; card checkout runs on the
 * organizer's own connected key, imajin-ai#2757).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ima-jin/logger';
import { NO_CARD_RAIL_CODE, NO_CARD_RAIL_MESSAGE, requestPayCheckoutSession } from '@/lib/checkout-helpers';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const originalFetch = globalThis.fetch;

const PARAMS = {
  payServiceUrl: 'https://pay.test/pay',
  items: [{ name: 'Fair — GA', amount: 2500, quantity: 1 }],
  currency: 'CAD',
  successUrl: 'https://events.test/ok',
  cancelUrl: 'https://events.test/no',
  fairManifest: null,
  sellerDid: 'did:imajin:organizer',
  metadata: { eventId: 'evt_1' },
  log,
};

function stubPay(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('requestPayCheckoutSession', () => {
  it('posts the checkout to pay and returns the session', async () => {
    const fetchMock = stubPay({ id: 'cs_1', url: 'https://stripe.test/cs_1' });

    const result = await requestPayCheckoutSession(PARAMS);

    expect(result).toEqual({ checkout: { id: 'cs_1', url: 'https://stripe.test/cs_1' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pay.test/pay/api/checkout');
    expect(JSON.parse(init.body as string)).toMatchObject({ sellerDid: 'did:imajin:organizer', currency: 'CAD' });
  });

  it.each([
    ['code', { code: NO_CARD_RAIL_CODE, error: 'seller has no card rail' }],
    ['error string', { error: NO_CARD_RAIL_CODE }],
  ])('surfaces a seller with no card rail plainly (%s)', async (_label, body) => {
    stubPay(body, 409);

    const result = await requestPayCheckoutSession(PARAMS);

    expect(result).toEqual({ error: NO_CARD_RAIL_MESSAGE, code: NO_CARD_RAIL_CODE, status: 409 });
  });

  it('maps any other pay failure to a 500 with the pay error message', async () => {
    stubPay({ error: 'Stripe is down' }, 502);

    expect(await requestPayCheckoutSession(PARAMS)).toEqual({ error: 'Stripe is down', status: 500 });
  });

  it('falls back to a generic message when pay gives none', async () => {
    stubPay({}, 500);

    expect(await requestPayCheckoutSession(PARAMS)).toEqual({ error: 'Payment service error', status: 500 });
  });
});
