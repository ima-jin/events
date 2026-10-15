/**
 * Tests for app/api/webhook/payment/route.ts — the #2739 wiring:
 * on a completed checkout events settles through the pay service with its own
 * app token (`settleCompletedOrder`) instead of publishing `order.completed`
 * for the kernel-only bus `settle` reactor.
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

  it('rejects an unsigned legacy Bearer before doing anything', async () => {
    const res = await callRoute(PAYLOAD, { unsigned: true, headers: { authorization: 'Bearer fake-retired-credential' } });

    expect(res.status).toBe(401);
    expect(mocks.settleCompletedOrder).not.toHaveBeenCalled();
    expect(mocks.createOrderWithTickets).not.toHaveBeenCalled();
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
