import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  ORDER_ID,
  dbMock,
  makeEvent,
  makeOrder,
  makeTicket,
  renderedWhere,
} from '@/__tests__/support/orders-support';

vi.mock('@/db', async (importOriginal) =>
  (await import('@/__tests__/support/orders-support')).dbModuleMock(importOriginal),
);

import {
  claimOrderOnboard,
  completeHostedOrder,
  findEventById,
  findOrderById,
  insertOrder,
  markOrderCompleted,
  markOrderRefunded,
} from '@/repositories/orders-repository';

beforeEach(() => dbMock.reset());

describe('stored hosted checkout lifecycle', () => {
  it('aborts the transaction on ticket insertion failure and allows a fresh pending-order attempt', async () => {
    const order = makeOrder();
    const ticket = makeTicket();
    const values = { id: ORDER_ID, eventId: EVENT_ID, amountTotal: 1 };
    dbMock.queue([order]);
    dbMock.queue(new Error('ticket insert unavailable'));
    await expect(completeHostedOrder(ORDER_ID, values, [ticket], [
      { ticketTypeId: 'type_1', quantity: 1 },
    ])).rejects.toThrow('ticket insert unavailable');
    // Counters were never updated after the failed insert. The real database
    // rolls the pending->completed update back with that rejected transaction.
    expect(dbMock.methods()).toEqual(['update', 'set', 'where', 'returning', 'insert', 'values', 'returning']);
    dbMock.queue([order]);
    dbMock.queue([ticket]);
    dbMock.queue([]);
    await expect(completeHostedOrder(ORDER_ID, values, [ticket], [
      { ticketTypeId: 'type_1', quantity: 1 },
    ])).resolves.toEqual({ order, tickets: [ticket] });
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(2);
    expect(dbMock.methods().slice(-3)).toEqual(['update', 'set', 'where']);
  });

  it('fails the whole transaction when a sold counter update fails', async () => {
    dbMock.queue([makeOrder()]);
    dbMock.queue([makeTicket()]);
    dbMock.queue(new Error('sold counter unavailable'));
    await expect(completeHostedOrder(ORDER_ID, {
      id: ORDER_ID, eventId: EVENT_ID, amountTotal: 1,
    }, [makeTicket()], [{ ticketTypeId: 'type_1', quantity: 1 }])).rejects.toThrow('sold counter unavailable');
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
  });
  it('only promotes an order while it is pending', async () => {
    const row = makeOrder({ metadata: { kernelTransactionId: 'tx_saved' } });
    dbMock.queue([row]);
    dbMock.queue([]);
    expect(await completeHostedOrder(ORDER_ID, {
      id: ORDER_ID, eventId: EVENT_ID, amountTotal: 1, metadata: row.metadata,
    }, [], [])).toEqual({ order: row, tickets: [] });
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    expect(renderedWhere().params).toEqual([ORDER_ID, 'pending']);
    expect(dbMock.argsOf('set')[0]).toMatchObject({ metadata: { kernelTransactionId: 'tx_saved' } });
  });

  it('refuses a concurrently completed or absent pending order', async () => {
    dbMock.queue([]);
    await expect(completeHostedOrder(ORDER_ID, {
      id: ORDER_ID, eventId: EVENT_ID, amountTotal: 1,
    }, [], [])).rejects.toThrow('no longer pending');
  });

  it('claims atomically only a confirmed hosted order with an unused, nonempty string reference', async () => {
    dbMock.queue([{ metadata: { kernelTransactionId: 'tx_saved' } }]);
    expect(await claimOrderOnboard(ORDER_ID)).toBe('tx_saved');
    expect(dbMock.methods()).toEqual(['update', 'set', 'where', 'returning']);
    const predicate = renderedWhere();
    expect(predicate.params).toEqual([ORDER_ID, 'completed', 'stripe']);
    expect(predicate.sql).toContain('"stripe_session_id" IS NOT NULL');
    expect(predicate.sql).toContain("jsonb_typeof");
    expect(predicate.sql).toContain("= 'string'");
    expect(predicate.sql).toContain('length(btrim(');
    expect(predicate.sql).toContain("> 0");
    expect(predicate.sql).toContain("NOT (");
    expect(predicate.sql).toContain("? 'onboardRequestedAt'");
    expect(predicate.sql).toContain("'kernelTransactionId'");
  });

  it('returns no reference when the eligibility or already-requested guard rejects the order', async () => {
    dbMock.queue([]);
    expect(await claimOrderOnboard(ORDER_ID)).toBeNull();
  });
});

describe('findOrderById', () => {
  it('returns the order row', async () => {
    const order = makeOrder();
    dbMock.queue([order]);

    expect(await findOrderById(ORDER_ID)).toBe(order);
    expect(dbMock.methods()).toEqual(['select', 'from', 'where', 'limit']);
    expect(renderedWhere().params).toEqual([ORDER_ID]);
  });

  it('returns null when there is no such order', async () => {
    dbMock.queue([]);

    expect(await findOrderById('ord_missing')).toBeNull();
  });
});

describe('insertOrder', () => {
  it('inserts the values and returns the stored row', async () => {
    const order = makeOrder();
    dbMock.queue([order]);

    expect(await insertOrder({ id: ORDER_ID, eventId: EVENT_ID, amountTotal: 1 })).toBe(order);
    expect(dbMock.methods()).toEqual(['insert', 'values', 'returning']);
    expect(dbMock.argsOf('values')[0]).toMatchObject({ id: ORDER_ID, eventId: EVENT_ID });
  });
});

describe('order status transitions', () => {
  it('markOrderCompleted sets completed + purchasedAt', async () => {
    const at = new Date('2026-01-01T00:00:00Z');

    await markOrderCompleted(ORDER_ID, at);

    expect(dbMock.methods()).toEqual(['update', 'set', 'where']);
    expect(dbMock.argsOf('set')[0]).toEqual({ status: 'completed', purchasedAt: at });
    expect(renderedWhere().params).toEqual([ORDER_ID]);
  });

  it('markOrderRefunded sets refunded', async () => {
    await markOrderRefunded(ORDER_ID);

    expect(dbMock.argsOf('set')[0]).toEqual({ status: 'refunded' });
    expect(renderedWhere().params).toEqual([ORDER_ID]);
  });
});

describe('findEventById', () => {
  it('returns the event row, or null', async () => {
    const event = makeEvent();
    dbMock.queue([event]);
    expect(await findEventById(EVENT_ID)).toBe(event);
    expect(renderedWhere().params).toEqual([EVENT_ID]);

    dbMock.queue([]);
    expect(await findEventById('evt_missing')).toBeNull();
  });
});
