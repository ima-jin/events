/**
 * Tests for app/api/checkout/route.ts — the #2739 wiring: the
 * pay `/api/checkout` call is authenticated with events' own app-service token
 * and declares the payee manifest, and checkout fails closed when events
 * cannot make the payment settleable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.PAY_SERVICE_URL = 'https://pay.test/pay';
  process.env.NEXT_PUBLIC_EVENTS_URL = 'https://events.test';
  return {
    getPayAppToken: vi.fn(),
    loadPublishedEvent: vi.fn(),
    validateCart: vi.fn(),
    resolveCheckoutIdentity: vi.fn(),
    resolveInviteAccessForEvent: vi.fn(),
    createSoftDidFromEmail: vi.fn(),
    publish: vi.fn(),
  };
});

vi.mock('@ima-jin/logger', () => ({
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
    handler(req, { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, correlationId: 'corr_1' }),
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/domain-events', () => ({ publish: mocks.publish }));
vi.mock('@ima-jin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
  eventUrl: (base: string, id: string) => `${base}/e/${id}`,
}));
vi.mock('@/db', () => ({ db: {}, eventInvites: {} }));
vi.mock('@/lib/checkout-common', () => ({
  validateCart: mocks.validateCart,
  resolveCheckoutIdentity: mocks.resolveCheckoutIdentity,
  resolveInviteAccessForEvent: mocks.resolveInviteAccessForEvent,
  loadPublishedEvent: mocks.loadPublishedEvent,
  createSoftDidFromEmail: mocks.createSoftDidFromEmail,
  CheckoutValidationError: class CheckoutValidationError extends Error {},
}));
vi.mock('@/lib/pay-app-token', () => ({
  getPayAppToken: mocks.getPayAppToken,
  invalidatePayAppToken: vi.fn(),
}));
// vitest aliases '@/' to apps/kernel, so the route's '@/lib/…' imports of events' own libs only
// resolve through a mock id — hand them the real modules (the code under test) by relative path.
vi.mock('@/lib/pay-settle', async () => import('@/lib/pay-settle'));
vi.mock('@/lib/checkout-helpers', async () => import('@/lib/checkout-helpers'));

import { POST } from '../../app/api/checkout/route';

const ORGANIZER = 'did:imajin:organizer';
const EVENT_TITLE = 'Summer Fair';
const EVENT_DID = 'did:imajin:evt_1';

const FAIR = {
  chain: [
    { did: ORGANIZER, role: 'seller', share: 0.96 },
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.04 },
  ],
};

const originalFetch = globalThis.fetch;

function request(body: Record<string, unknown>) {
  return { json: async () => body, nextUrl: { searchParams: new URLSearchParams() }, headers: new Headers() };
}

function callRoute(body: Record<string, unknown> = { eventId: 'evt_1', ticketTypeId: 'tt_1', quantity: 2 }) {
  return (POST as unknown as (req: unknown) => Promise<Response>)(request(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPayAppToken.mockResolvedValue('events-app-token');
  mocks.loadPublishedEvent.mockResolvedValue({
    event: { id: 'evt_1', did: EVENT_DID, title: EVENT_TITLE, creatorDid: ORGANIZER, metadata: { fair: FAIR } },
  });

  mocks.resolveInviteAccessForEvent.mockResolvedValue(null);
  mocks.validateCart.mockResolvedValue({
    typesById: new Map([['tt_1', { name: 'GA', description: null, price: 2500, quantity: null, sold: 0 }]]),
    totalQuantity: 2,
    currency: 'CAD',
  });
  mocks.resolveCheckoutIdentity.mockResolvedValue({ did: 'did:imajin:buyer', email: 'buyer@example.test' });
  mocks.publish.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /api/checkout — app-authenticated pay checkout (imajin-ai#2739)', () => {
  it('calls pay /api/checkout with events’ app token as Bearer and the resolved payeeManifest', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe.test/cs_1', transactionId: 'tx_1' })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://stripe.test/cs_1', sessionId: 'cs_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://pay.test/pay/api/checkout');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer events-app-token');
    const payBody = JSON.parse(init.body as string);
    // 2 × $25.00 = $50.00, split 96% / 4% with no processor deduction.
    expect(payBody.payeeManifest).toEqual({
      chain: [
        { did: ORGANIZER, role: 'seller', amount: 48 },
        { did: 'did:imajin:protocol', role: 'protocol', amount: 2 },
      ],
    });
    expect(payBody.fairManifest).toEqual(FAIR);
    expect(payBody.metadata).toMatchObject({ service: 'events', eventId: 'evt_1', buyerDid: 'did:imajin:buyer' });
  });

  it.each([FAIR, null, undefined, { chain: [] }, { fees: [] }])('fails closed with a retryable 503 and no pay call when minting fails for %j', async (fair) => {
    mocks.loadPublishedEvent.mockResolvedValue({
      event: { id: 'evt_1', did: EVENT_DID, title: EVENT_TITLE, creatorDid: ORGANIZER, metadata: { fair } },
    });
    mocks.getPayAppToken.mockRejectedValue(new Error('loadAppSigningKey: no keystore found'));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await callRoute();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payment service unavailable; please retry checkout' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.getPayAppToken).toHaveBeenCalledTimes(1);

    // A later buyer retry can recover; the failed request never fell back to anonymous pay.
    mocks.getPayAppToken.mockResolvedValue('events-app-token');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cs_retry', url: 'https://stripe.test/cs_retry' })));
    const retry = await callRoute();
    expect(retry.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer events-app-token');
  });

  it('400s before calling pay when the chain pays the buyer but no email or session identifies them', async () => {
    mocks.loadPublishedEvent.mockResolvedValue({
      event: {
        id: 'evt_1',
        did: EVENT_DID,
        title: EVENT_TITLE,
        creatorDid: ORGANIZER,
        metadata: { fair: { chain: [...FAIR.chain.slice(0, 1), { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.04 }] } },
      },
    });
    mocks.resolveCheckoutIdentity.mockResolvedValue({});
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await callRoute();

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, undefined, { chain: [] }, { fees: [] }])('authenticates a seller checkout with no payee chain (%j)', async (fair) => {
    mocks.loadPublishedEvent.mockResolvedValue({
      event: { id: 'evt_1', did: EVENT_DID, title: EVENT_TITLE, creatorDid: ORGANIZER, metadata: { fair } },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_2', url: 'https://stripe.test/cs_2' })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await callRoute();

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer events-app-token');
    const payBody = JSON.parse(init.body as string);
    expect(payBody.sellerDid).toBe(ORGANIZER);
    expect(payBody).not.toHaveProperty('payeeManifest');
    expect(payBody).not.toHaveProperty('appAuth');
    expect(mocks.getPayAppToken).toHaveBeenCalledTimes(1);
    expect(mocks.createSoftDidFromEmail).not.toHaveBeenCalled();
  });

  describe.each(['today', '#2873'])('seller-checkout public contract: %s kernel (test double)', (kernel) => {
    it.each([FAIR, null])('opens a session for a paid checkout with manifest %j', async (fair) => {
      mocks.loadPublishedEvent.mockResolvedValue({
        event: { id: 'evt_1', did: EVENT_DID, title: EVENT_TITLE, creatorDid: ORGANIZER, metadata: { fair } },
      });
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        const authorization = new Headers(init.headers).get('Authorization');
        if (kernel === '#2873' && body.sellerDid && authorization !== 'Bearer events-app-token') {
          return new Response(JSON.stringify({ error: 'App-service token required' }), { status: 401 });
        }
        expect(authorization).toBe('Bearer events-app-token');
        expect(body.sellerDid).toBe(ORGANIZER);
        expect(body.items).toEqual([{ name: `${EVENT_TITLE} — GA`, amount: 2500, quantity: 2 }]);
        expect(body.currency).toBe('CAD');
        return new Response(JSON.stringify({ id: 'cs_compatible', url: 'https://stripe.test/cs_compatible' }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await callRoute();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'https://stripe.test/cs_compatible', sessionId: 'cs_compatible' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces the pay service’s refusal (e.g. 403 pay:settle not approved) as a checkout error', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden - 'pay:settle' is not operator-approved for this app" }), { status: 403 })) as unknown as typeof fetch;

    const res = await callRoute();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Forbidden - 'pay:settle' is not operator-approved for this app" });
  });
});
