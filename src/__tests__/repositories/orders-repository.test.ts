import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  ORDER_ID,
  dbMock,
  makeEvent,
  makeOrder,
  renderedWhere,
} from '@/__tests__/support/orders-support';

vi.mock('@/db', async (importOriginal) =>
  (await import('@/__tests__/support/orders-support')).dbModuleMock(importOriginal),
);

import {
  findEventById,
  findOrderById,
  insertOrder,
  markOrderCompleted,
  markOrderRefunded,
} from '@/repositories/orders-repository';

beforeEach(() => dbMock.reset());

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
