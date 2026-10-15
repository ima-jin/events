/**
 * Tests for app/api/webhook/settlement/route.ts: the receipt snapshot written to the order when a
 * settlement.completed event arrives — authenticated by a kernel signature, failing closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupKernelWebhooks, signedRequest, discovery, foreignKey, type SignedRequestOptions } from '../../test/kernel-webhook';
import { configureEventsWebhookNonceStore } from '@/lib/kernel-webhook';

setupKernelWebhooks();

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn<(values: Record<string, unknown>) => { where: typeof where }>(() => ({ where }));
  return { where, set, update: vi.fn(() => ({ set })), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/db', () => ({ db: { update: mocks.update }, orders: {} }));

import { POST } from '../../app/api/webhook/settlement/route';

const PAYLOAD = {
  orderId: 'ord_1',
  totalAmount: 50,
  netAmount: 48,
  currency: 'CAD',
  fees: [],
  chain: [{ did: 'did:imajin:organizer', amount: 48, role: 'seller' }],
};

function call(body: unknown, options: SignedRequestOptions = {}) {
  return POST(signedRequest('/api/webhook/settlement', body, options) as never);
}

/** The `fairSettlement` snapshot the route wrote to the order. */
function settlementWritten(): Record<string, unknown> {
  return mocks.set.mock.calls[0]![0].fairSettlement as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhook/settlement', () => {
  it('writes the .fair receipt snapshot to the order', async () => {
    const res = await call(PAYLOAD);

    expect(res.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith({
      fairSettlement: expect.objectContaining({ version: '1.1', totalAmount: 50, netAmount: 48, chain: PAYLOAD.chain }),
    });
    expect(settlementWritten()).not.toHaveProperty('rail');
  });

  it('accepts the bus envelope and records the rail of a BYO receipt', async () => {
    const res = await call({ payload: { ...PAYLOAD, chain: [], netAmount: 50, rail: 'stripe-byo' } });

    expect(res.status).toBe(200);
    expect(settlementWritten()).toMatchObject({ chain: [], netAmount: 50, rail: 'stripe-byo' });
  });

  it('answers 400 without an orderId', async () => {
    expect((await call({ ...PAYLOAD, orderId: undefined })).status).toBe(400);
  });
  it.each(['audience', 'kid', 'timestamp', 'nonce', 'signature'])('rejects a missing x-kernel-%s header', async (header) => {
    const request = signedRequest('/api/webhook/settlement', PAYLOAD);
    request.headers.delete(`x-kernel-${header}`);
    expect((await POST(request as never)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', { timestampOffsetSeconds: -301 }],
    ['future', { timestampOffsetSeconds: 301 }],
    ['tampered', { tampered: true }],
    ['foreign signer', { privateKey: foreignKey.privateKey }],
    ['wrong audience', { audience: 'did:imajin:another-app' }],
    ['unsigned', { unsigned: true }],
    ['legacy header', { unsigned: true, headers: { 'x-webhook-secret': 'fake-retired-credential' } }],
  ])('rejects %s without updating the order', async (_label, options) => {
    expect((await call(PAYLOAD, options)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a replay, including after recreating the adapter', async () => {
    const request = signedRequest('/api/webhook/settlement', PAYLOAD);
    expect((await POST(request.clone() as never)).status).toBe(200);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@ima-jin/events:kernel-webhook-nonce-store')];
    expect((await POST(request as never)).status).toBe(401);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it.each(['not-json', 'null', '[]'])('answers 400 for signed invalid payload %s', async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 503 when discovery fails', async () => {
    discovery.mockRejectedValue(new Error('discovery down'));
    expect((await call(PAYLOAD)).status).toBe(503);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 503 when replay storage fails', async () => {
    configureEventsWebhookNonceStore({ consume: () => { throw new Error('store down'); } });
    expect((await call(PAYLOAD)).status).toBe(503);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 500 when the snapshot write fails', async () => {
    mocks.where.mockRejectedValueOnce(new Error('db down'));

    expect((await call(PAYLOAD)).status).toBe(500);
  });
});
