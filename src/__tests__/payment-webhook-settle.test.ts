/**
 * Signed completions must match the seller and DB-priced cart before fulfilment.
 * Accepted BYO payments record the kernel-settled receipt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupKernelWebhooks, signedRequest, foreignKey, discovery, type SignedRequestOptions } from '../../test/kernel-webhook';
import { configureEventsWebhookNonceStore } from '@/lib/kernel-webhook';

setupKernelWebhooks();

const mocks = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  return {
    selectQueue,
    settleCompletedOrder: vi.fn(),
    recordByoSettlement: vi.fn(),
    createOrderWithTickets: vi.fn(),
    busPublish: vi.fn(),
    publishConfirmationEmails: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@ima-jin/logger', () => ({
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
    handler(req, { log: mocks.log }),
  createLogger: () => mocks.log,
}));
vi.mock('@/lib/domain-events', () => ({ publish: mocks.busPublish }));
vi.mock('@ima-jin/config', () => ({
  eventRegisterUrl: (base: string, eventId: string, ticketId: string) => `${base}/e/${eventId}/register/${ticketId}`,
  eventMyTicketsUrl: (base: string, eventId: string) => `${base}/e/${eventId}/tickets`,
  buildPublicUrlAbsolute: (name: string) => `https://${name}.test`,
}));
vi.mock('@/db', () => {
  // db.select().from().where() is awaited directly in some places and `.limit()`-ed in others.
  const where = () => {
    const result = Promise.resolve(mocks.selectQueue.shift() ?? []);
    return Object.assign(result, { limit: () => result });
  };
  return {
    db: {
      select: () => ({ from: () => ({ where }) }),
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    },
    events: {},
    ticketTypes: {},
    tickets: {},
    orders: {},
  };
});
vi.mock('@/lib/contact-email', () => ({ backfillContactEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/checkout-common', () => ({ createOrderWithTickets: mocks.createOrderWithTickets }));
vi.mock('@/lib/pay-settle', () => ({
  settleCompletedOrder: mocks.settleCompletedOrder,
  recordByoSettlement: mocks.recordByoSettlement,
}));
vi.mock('@/lib/webhook-payment-helpers', async (importOriginal) => ({
  parseCartFromMetadata: (await importOriginal<typeof import('@/lib/webhook-payment-helpers')>()).parseCartFromMetadata,
  syncBuyerToEventChat: vi.fn().mockResolvedValue(undefined),
  publishConfirmationEmails: mocks.publishConfirmationEmails,
}));

import { POST } from '../../app/api/webhook/payment/route';

const ORGANIZER = 'did:imajin:organizer';
const FAIR = { chain: [{ did: ORGANIZER, role: 'seller', share: 1 }] };
const EVENT = { id: 'evt_1', did: 'did:imajin:evt_1', title: 'Summer Fair', creatorDid: ORGANIZER, privateKey: 'x', currency: 'CAD', metadata: { fair: FAIR } };
const TICKET_TYPE = { id: 'tt_1', name: 'GA', eventId: 'evt_1', price: 2500, currency: 'CAD' };

const PAYLOAD = {
  type: 'checkout.completed',
  sessionId: 'cs_1',
  paymentId: 'pi_1',
  transactionId: 'tx_1',
  rail: 'stripe-byo',
  sellerDid: ORGANIZER,
  customerEmail: 'buyer@example.test',
  customerName: 'Buyer',
  amountTotal: 5000,
  currency: 'cad',
  metadata: { eventId: 'evt_1', eventDid: 'did:imajin:evt_1', buyerDid: 'did:imajin:buyer', ticketTypeId: 'tt_1', quantity: '2' },
};

const callRoute = (body: unknown = PAYLOAD, options: SignedRequestOptions = {}) =>
  POST(signedRequest('/api/webhook/payment', body, options) as never);

beforeEach(() => {
  vi.clearAllMocks();
  // select order inside handleCheckoutCompleted: duplicate-order check, event, ticket types, owner's soft-DID tickets.
  mocks.selectQueue.length = 0;
  mocks.selectQueue.push([], [EVENT], [TICKET_TYPE], []);
  mocks.createOrderWithTickets.mockResolvedValue({
    tickets: [{ id: 'tkt_1', registrationStatus: 'not_required', pricePaid: 2500 }, { id: 'tkt_2', registrationStatus: 'not_required', pricePaid: 2500 }],
    order: { id: 'ord_1' },
  });
  mocks.settleCompletedOrder.mockResolvedValue({ status: 'settled', alreadySettled: false, manifest: { chain: [] } });
  mocks.recordByoSettlement.mockResolvedValue(undefined);
  mocks.busPublish.mockResolvedValue(undefined);
  mocks.publishConfirmationEmails.mockResolvedValue(undefined);
});
describe('POST /api/webhook/payment — verify payment before fulfilment (#64)', () => {
  function expectNoFulfilment() {
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.busPublish).not.toHaveBeenCalled();
    expect(mocks.publishConfirmationEmails).not.toHaveBeenCalled();
    // Owner resolution/migration would consume the fourth DB result.
    expect(mocks.selectQueue).toHaveLength(1);
  }

  it.each([
    ['underpriced cart', { amountTotal: 50 }],
    ['overpriced cart', { amountTotal: 5001 }],
    ['fractional amount', { amountTotal: 5000.5 }],
    ['string amount', { amountTotal: '5000' }],
    ['missing amount', { amountTotal: undefined }],
    ['wrong seller despite matching metadata', { sellerDid: 'did:imajin:attacker', metadata: { ...PAYLOAD.metadata, sellerDid: ORGANIZER } }],
    ['missing seller despite matching metadata', { sellerDid: undefined, metadata: { ...PAYLOAD.metadata, sellerDid: ORGANIZER } }],
    ['missing rail', { rail: undefined }],
    ['empty rail', { rail: '' }],
    ['platform completion', { rail: undefined, sellerDid: undefined }],
    ['explicit platform rail', { rail: 'stripe' }],
    ['currency mismatch', { currency: 'usd' }],
    ['missing currency', { currency: undefined }],
  ])('acknowledges %s without creating an order or tickets', async (_label, extra) => {
    const body = { ...PAYLOAD, ...extra };
    const res = await callRoute(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expectNoFulfilment();
    expect(mocks.log.warn).toHaveBeenCalledWith({
      eventId: 'evt_1', sessionId: 'cs_1', reason: expect.any(String),
      expected: { rail: 'stripe-byo', sellerDid: ORGANIZER, currency: 'CAD', amountTotal: 5000 },
      got: {
        rail: body.rail ?? null, sellerDid: body.sellerDid ?? null,
        currency: body.currency ?? null, amountTotal: body.amountTotal ?? null,
      },
    }, 'Payment completion refused');
  });

  it('ignores a forged metadata seller when the attested seller is correct', async () => {
    const res = await callRoute({ ...PAYLOAD, metadata: { ...PAYLOAD.metadata, sellerDid: 'did:imajin:attacker' } });
    expect(res.status).toBe(200);
    expect(mocks.createOrderWithTickets).toHaveBeenCalledTimes(1);
  });

  it('refuses ticket currency inconsistent with the event even when payment matches the event', async () => {
    mocks.selectQueue[2] = [{ ...TICKET_TYPE, currency: 'USD' }];
    expect((await callRoute()).status).toBe(200);
    expectNoFulfilment();
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ticket_currency_mismatch',
    }), 'Payment completion refused');
  });

  it('refuses an unknown or other-event ticket type', async () => {
    mocks.selectQueue[2] = [];
    expect((await callRoute()).status).toBe(200);
    expectNoFulfilment();
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'unknown_ticket_type',
    }), 'Payment completion refused');
  });

  it.each([
    'not-json', 'null', '{}', '[]', '[null]',
    '[{"ticketTypeId":"tt_1","quantity":0}]',
    '[{"ticketTypeId":"tt_1","quantity":-1}]',
    '[{"ticketTypeId":"tt_1","quantity":1.5}]',
    '[{"ticketTypeId":"tt_1","quantity":"2"}]',
    '[{"ticketTypeId":"","quantity":2}]',
    '[{"quantity":2}]',
    '[{"ticketTypeId":"tt_1","quantity":9007199254740992}]',
  ])('acknowledges invalid cart %s without side effects', async (cart) => {
    expect((await callRoute({ ...PAYLOAD, metadata: { ...PAYLOAD.metadata, cart } })).status).toBe(200);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.busPublish).not.toHaveBeenCalled();
    expect(mocks.selectQueue).toHaveLength(4);
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'evt_1', sessionId: 'cs_1', reason: 'invalid_cart',
      expected: expect.any(Object), got: expect.any(Object),
    }), 'Payment completion refused');
  });

  it('does not parse a legacy quantity with a trailing suffix as an integer', async () => {
    expect((await callRoute({ ...PAYLOAD, metadata: { ...PAYLOAD.metadata, quantity: '2oops' } })).status).toBe(200);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it.each([15000, 50])('prices every type in a multi-type cart (paid %i)', async (amountTotal) => {
    const cart = [{ ticketTypeId: 'tt_1', quantity: 2 }, { ticketTypeId: 'tt_vip', quantity: 1 }];
    mocks.selectQueue[2] = [TICKET_TYPE, { ...TICKET_TYPE, id: 'tt_vip', name: 'VIP', price: 10000 }];
    const res = await callRoute({ ...PAYLOAD, amountTotal, metadata: { ...PAYLOAD.metadata, cart: JSON.stringify(cart) } });
    expect(res.status).toBe(200);
    if (amountTotal === 15000) {
      expect(mocks.createOrderWithTickets).toHaveBeenCalledWith(expect.objectContaining({
        cart, totalAmount: 15000, totalQuantity: 3,
      }));
    } else {
      expectNoFulfilment();
      expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({
        expected: expect.objectContaining({ amountTotal: 15000 }),
        got: expect.objectContaining({ amountTotal: 50 }),
      }), 'Payment completion refused');
    }
  });
});

describe('POST /api/webhook/payment — kernel signatures', () => {
  it.each(['audience', 'kid', 'timestamp', 'nonce', 'signature'])('rejects a missing x-kernel-%s header', async (header) => {
    const request = signedRequest('/api/webhook/payment', PAYLOAD);
    request.headers.delete(`x-kernel-${header}`);
    expect((await POST(request as never)).status).toBe(401);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it('accepts a valid signature independently of bridge headers', async () => {
    expect((await callRoute(PAYLOAD, {
      headers: { authorization: 'Bearer fake-legacy-placeholder', 'x-webhook-secret': 'fake-legacy-placeholder' },
    })).status).toBe(200);
    expect(mocks.createOrderWithTickets).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['stale', { timestampOffsetSeconds: -301 }],
    ['future', { timestampOffsetSeconds: 301 }],
    ['wrong audience', { audience: 'did:imajin:another-app' }],
    ['tampered bytes', { tampered: true }],
    ['foreign signer', { privateKey: foreignKey.privateKey }],
    ['wrong path/query', { signedUrl: 'https://events.test/events/api/webhook/payment?changed=1' }],
    ['wrong method', { signedMethod: 'PUT' }],
    ['unsigned', { unsigned: true }],
  ])('rejects %s with no business effects', async (_label, options) => {
    expect((await callRoute(PAYLOAD, options)).status).toBe(401);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.busPublish).not.toHaveBeenCalled();
  });

  it('rejects replay after a successful signed checkout', async () => {
    const request = signedRequest('/api/webhook/payment', PAYLOAD);
    expect((await POST(request.clone() as never)).status).toBe(200);
    expect((await POST(request as never)).status).toBe(401);
    expect(mocks.createOrderWithTickets).toHaveBeenCalledTimes(1);
  });

  it('preserves order idempotency for a freshly signed redelivery', async () => {
    mocks.selectQueue.length = 0;
    mocks.selectQueue.push([{ id: 'existing-order' }]);
    expect((await callRoute()).status).toBe(200);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
  });

  it.each(['not-json', 'null', '[]'])('rejects signed invalid payload %s with 400', async (body) => {
    expect((await callRoute(body)).status).toBe(400);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it('fails closed when discovery is unavailable', async () => {
    discovery.mockRejectedValue(new Error('discovery unavailable'));
    expect((await callRoute()).status).toBe(503);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it('fails closed when the replay store is unavailable', async () => {
    configureEventsWebhookNonceStore({ consume: () => { throw new Error('store unavailable'); } });
    expect((await callRoute()).status).toBe(503);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it('fails closed when the app DID is not configured', async () => {
    vi.stubEnv('IMAJIN_APP_DID', '');
    expect((await callRoute()).status).toBe(503);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhook/payment — BYO card rail (kernel #2766: the kernel already settled it)', () => {
  const RECEIPT = {
    orderId: 'ord_1',
    eventId: 'evt_1',
    buyerDid: 'did:imajin:buyer',
    creatorDid: ORGANIZER,
    amountCents: 5000,
    currency: 'cad',
    metadata: { orderId: 'ord_1', ticketIds: ['tkt_1', 'tkt_2'], ticketTypeId: 'tt_1', stripeSessionId: 'cs_1', eventId: 'evt_1' },
    log: mocks.log,
  };

  it('records the verified BYO receipt and never calls /pay/api/settle', async () => {
    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.recordByoSettlement).toHaveBeenCalledTimes(1);
    expect(mocks.recordByoSettlement).toHaveBeenCalledWith(RECEIPT);
    expect(mocks.createOrderWithTickets).toHaveBeenCalledWith(expect.objectContaining({
      totalAmount: 5000, totalQuantity: 2, currency: 'CAD', incrementSold: true,
    }));
  });

  it('still creates the order, announces the tickets and sends the confirmation for a BYO payment', async () => {
    await callRoute({ ...PAYLOAD, rail: 'stripe-byo' });

    expect(mocks.createOrderWithTickets).toHaveBeenCalledTimes(1);
    expect(mocks.busPublish.mock.calls.map(([type]) => type)).toContain('ticket.purchased');
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });

  it('keeps the order and acknowledges the webhook when recording the BYO receipt throws (non-fatal)', async () => {
    mocks.recordByoSettlement.mockRejectedValue(new Error('bus down'));

    const res = await callRoute({ ...PAYLOAD, rail: 'stripe-byo' });

    expect(res.status).toBe(200);
    expect(mocks.log.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, expect.stringContaining('[settle]'));
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });
});
