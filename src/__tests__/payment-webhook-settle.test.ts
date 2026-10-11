/**
 * Tests for app/api/webhook/payment/route.ts — the #2739 wiring:
 * on a completed checkout events settles through the pay service with its own
 * app token (`settleCompletedOrder`) instead of publishing `order.completed`
 * for the kernel-only bus `settle` reactor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.WEBHOOK_SECRET = 'test-webhook-secret';
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
vi.mock('@/lib/pay-settle', async (importOriginal) => ({
  // `isByoPayment` is pure and is the code under test here; only the I/O is replaced.
  isByoPayment: (await importOriginal<typeof import('@/lib/pay-settle')>()).isByoPayment,
  settleCompletedOrder: mocks.settleCompletedOrder,
  recordByoSettlement: mocks.recordByoSettlement,
}));
vi.mock('@/lib/webhook-payment-helpers', () => ({
  parseCartFromMetadata: () => [{ ticketTypeId: 'tt_1', quantity: 2 }],
  syncBuyerToEventChat: vi.fn().mockResolvedValue(undefined),
  publishConfirmationEmails: mocks.publishConfirmationEmails,
}));

import { POST } from '../../app/api/webhook/payment/route';

const WEBHOOK_SECRET = 'test-webhook-secret';
const ORGANIZER = 'did:imajin:organizer';
const FAIR = { chain: [{ did: ORGANIZER, role: 'seller', share: 1 }] };
const EVENT = { id: 'evt_1', did: 'did:imajin:evt_1', title: 'Summer Fair', creatorDid: ORGANIZER, privateKey: 'x', metadata: { fair: FAIR } };
const TICKET_TYPE = { id: 'tt_1', name: 'GA', eventId: 'evt_1' };

const PAYLOAD = {
  type: 'checkout.completed',
  sessionId: 'cs_1',
  paymentId: 'pi_1',
  transactionId: 'tx_1',
  customerEmail: 'buyer@example.test',
  customerName: 'Buyer',
  amountTotal: 5000,
  currency: 'cad',
  metadata: { eventId: 'evt_1', eventDid: 'did:imajin:evt_1', buyerDid: 'did:imajin:buyer' },
};

function request(body: unknown, authorization = `Bearer ${WEBHOOK_SECRET}`) {
  return { headers: new Headers({ authorization }), json: async () => body };
}

const callRoute = (body: unknown = PAYLOAD, authorization?: string) =>
  (POST as unknown as (req: unknown) => Promise<Response>)(request(body, authorization));

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
  process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
  mocks.busPublish.mockResolvedValue(undefined);
  mocks.publishConfirmationEmails.mockResolvedValue(undefined);
});

describe('POST /api/webhook/payment — settle via events’ app token (imajin-ai#2739)', () => {
  it('settles the completed order through the pay service with the order, session and .fair manifest', async () => {
    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith({
      sessionId: 'cs_1',
      transactionId: 'tx_1',
      orderId: 'ord_1',
      eventId: 'evt_1',
      buyerDid: 'did:imajin:buyer',
      creatorDid: ORGANIZER,
      amountCents: 5000,
      currency: 'cad',
      fairManifest: FAIR,
      metadata: {
        orderId: 'ord_1',
        ticketIds: ['tkt_1', 'tkt_2'],
        ticketTypeId: 'tt_1',
        stripeSessionId: 'cs_1',
        eventId: 'evt_1',
      },
      log: mocks.log,
    });
  });

  it('no longer publishes order.completed on the bus (that reactor only settles inside the kernel process)', async () => {
    await callRoute();

    const published = mocks.busPublish.mock.calls.map(([type]) => type);
    expect(published).not.toContain('order.completed');
    expect(published).toContain('ticket.purchased');
  });

  it('passes a null manifest through for an event with no .fair chain', async () => {
    mocks.selectQueue.length = 0;
    mocks.selectQueue.push([], [{ ...EVENT, metadata: {} }], [TICKET_TYPE], []);

    await callRoute();

    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith(expect.objectContaining({ fairManifest: null }));
  });

  it('passes no transactionId through when the pay webhook does not carry one (settle then skips loudly)', async () => {
    const withoutTransactionId = { ...PAYLOAD, transactionId: undefined };

    const res = await callRoute(withoutTransactionId);

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cs_1', transactionId: undefined }));
  });

  it('keeps the order and acknowledges the webhook when settlement throws (non-fatal)', async () => {
    mocks.settleCompletedOrder.mockRejectedValue(new Error('unexpected'));

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.log.error).toHaveBeenCalledWith({ err: 'Error: unexpected' }, expect.stringContaining('[settle]'));
    // The confirmation email still goes out after a settlement failure.
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });

  it('rejects a webhook without the shared secret before doing anything', async () => {
    const res = await callRoute(PAYLOAD, 'Bearer wrong-secret');

    expect(res.status).toBe(401);
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhook/payment — webhook authentication', () => {
  it.each([
    ['a token of the same length', `Bearer ${'x'.repeat(WEBHOOK_SECRET.length)}`],
    ['a longer token', `Bearer ${WEBHOOK_SECRET}-extra`],
    ['the bare secret without a scheme', WEBHOOK_SECRET],
    ['an empty header', ''],
  ])('answers 401 for %s', async (_label, authorization) => {
    const res = await callRoute(PAYLOAD, authorization);

    expect(res.status).toBe(401);
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
  });

  it('answers 401 when the request carries no Authorization header at all', async () => {
    const res = await (POST as unknown as (req: unknown) => Promise<Response>)({
      headers: new Headers(),
      json: async () => PAYLOAD,
    });

    expect(res.status).toBe(401);
  });

  it('fails closed with 401 — not a crash — when WEBHOOK_SECRET is not configured', async () => {
    delete process.env.WEBHOOK_SECRET;

    const res = await callRoute(PAYLOAD, 'Bearer undefined');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
  });

  it('reads the secret when the request arrives, not at import time', async () => {
    process.env.WEBHOOK_SECRET = 'rotated-secret';

    expect((await callRoute(PAYLOAD, `Bearer ${WEBHOOK_SECRET}`)).status).toBe(401);
    expect((await callRoute(PAYLOAD, 'Bearer rotated-secret')).status).toBe(200);
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

  it.each([
    ['rail is stripe-byo', { rail: 'stripe-byo' }],
    ['sellerDid is present on the notification (the interim indicator, imajin-ai#2776)', { sellerDid: ORGANIZER }],
    ['sellerDid is present on the notification metadata', { metadata: { ...PAYLOAD.metadata, sellerDid: ORGANIZER } }],
  ])('records the receipt and never calls /pay/api/settle when %s', async (_label, extra) => {
    const res = await callRoute({ ...PAYLOAD, ...extra });

    expect(res.status).toBe(200);
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.recordByoSettlement).toHaveBeenCalledTimes(1);
    expect(mocks.recordByoSettlement).toHaveBeenCalledWith(RECEIPT);
  });

  it('still creates the order, announces the tickets and sends the confirmation for a BYO payment', async () => {
    await callRoute({ ...PAYLOAD, rail: 'stripe-byo' });

    expect(mocks.createOrderWithTickets).toHaveBeenCalledTimes(1);
    expect(mocks.busPublish.mock.calls.map(([type]) => type)).toContain('ticket.purchased');
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });

  it('settles a platform-collected payment (no rail, no sellerDid) through the pay service as before', async () => {
    await callRoute(PAYLOAD);

    expect(mocks.settleCompletedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
  });

  it('keeps the order and acknowledges the webhook when recording the BYO receipt throws (non-fatal)', async () => {
    mocks.recordByoSettlement.mockRejectedValue(new Error('bus down'));

    const res = await callRoute({ ...PAYLOAD, rail: 'stripe-byo' });

    expect(res.status).toBe(200);
    expect(mocks.log.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, expect.stringContaining('[settle]'));
    expect(mocks.publishConfirmationEmails).toHaveBeenCalledTimes(1);
  });
});
