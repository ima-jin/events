/**
 * Tests for app/api/webhook/settlement/route.ts: the receipt snapshot written to the order when a
 * settlement.completed event arrives — authenticated in constant time, failing closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn<(values: Record<string, unknown>) => { where: typeof where }>(() => ({ where }));
  return { where, set, update: vi.fn(() => ({ set })), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/db', () => ({ db: { update: mocks.update }, orders: {} }));

import { POST } from '../../app/api/webhook/settlement/route';

const SECRET = 'receipt-secret';
const PAYLOAD = {
  orderId: 'ord_1',
  totalAmount: 50,
  netAmount: 48,
  currency: 'CAD',
  fees: [],
  chain: [{ did: 'did:imajin:organizer', amount: 48, role: 'seller' }],
};

function call(body: unknown, secret: string | null = SECRET) {
  const headers = new Headers(secret === null ? {} : { 'x-webhook-secret': secret });
  return POST({ headers, json: async () => body } as never);
}

/** The `fairSettlement` snapshot the route wrote to the order. */
function settlementWritten(): Record<string, unknown> {
  return mocks.set.mock.calls[0]![0].fairSettlement as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBHOOK_SECRET = SECRET;
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

  it.each([
    ['a wrong secret of the same length', 'x'.repeat(SECRET.length)],
    ['a longer secret', `${SECRET}-extra`],
    ['no header', null],
  ])('answers 401 for %s and writes nothing', async (_label, secret) => {
    expect((await call(PAYLOAD, secret)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('fails closed with 401 when WEBHOOK_SECRET is not configured', async () => {
    delete process.env.WEBHOOK_SECRET;

    expect((await call(PAYLOAD, 'undefined')).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('answers 500 when the snapshot write fails', async () => {
    mocks.where.mockRejectedValueOnce(new Error('db down'));

    expect((await call(PAYLOAD)).status).toBe(500);
  });
});
