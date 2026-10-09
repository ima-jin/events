import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  ORDER_ID,
  TICKET_ID,
  TYPE_ID,
  dbMock,
  makeTicket,
  renderedWhere,
} from '@/__tests__/support/orders-support';

vi.mock('@/db', async (importOriginal) =>
  (await import('@/__tests__/support/orders-support')).dbModuleMock(importOriginal),
);

import {
  cancelTicketRow,
  findHeldEtransferTicketsByOrder,
  findRefundableTicketsByOrder,
  findTicketById,
  findTicketInEvent,
  findTicketStatus,
  insertTicket,
  loadRefundableTicket,
  markHeldTicketsValid,
  markRefundSentRow,
  markTicketsRefunded,
  releaseExpiredHolds,
  setTicketRefundStatus,
} from '@/repositories/tickets-repository';

const ROW = { id: TICKET_ID, status: 'valid' };

beforeEach(() => dbMock.reset());

describe('ticket lookups', () => {
  it('findTicketById returns the row or null', async () => {
    const ticket = makeTicket();
    dbMock.queue([ticket]);
    expect(await findTicketById(TICKET_ID)).toBe(ticket);
    expect(renderedWhere().params).toEqual([TICKET_ID]);

    dbMock.queue([]);
    expect(await findTicketById('tkt_missing')).toBeNull();
  });

  it('findTicketInEvent scopes by event', async () => {
    const ticket = makeTicket();
    dbMock.queue([ticket]);
    expect(await findTicketInEvent(EVENT_ID, TICKET_ID)).toBe(ticket);
    expect(renderedWhere().params).toEqual([TICKET_ID, EVENT_ID]);

    dbMock.queue([]);
    expect(await findTicketInEvent(EVENT_ID, 'tkt_missing')).toBeNull();
  });

  it('findHeldEtransferTicketsByOrder filters order, held status and e-Transfer', async () => {
    const rows = [makeTicket({ status: 'held' })];
    dbMock.queue(rows);

    expect(await findHeldEtransferTicketsByOrder(ORDER_ID)).toBe(rows);
    expect(renderedWhere().params).toEqual([ORDER_ID, 'held', 'etransfer']);
  });

  it('findRefundableTicketsByOrder filters valid/used tickets of the order', async () => {
    const rows = [makeTicket()];
    dbMock.queue(rows);

    expect(await findRefundableTicketsByOrder(ORDER_ID)).toBe(rows);
    expect(renderedWhere().params).toEqual([ORDER_ID, 'valid', 'used']);
  });
});

describe('ticket writes', () => {
  it('insertTicket returns the stored row', async () => {
    const ticket = makeTicket();
    dbMock.queue([ticket]);

    expect(await insertTicket({ id: TICKET_ID, eventId: EVENT_ID, ticketTypeId: TYPE_ID })).toBe(ticket);
    expect(dbMock.methods()).toEqual(['insert', 'values', 'returning']);
  });

  it('markHeldTicketsValid confirms still-held tickets and returns the changed rows', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const rows = [makeTicket()];
    dbMock.queue(rows);

    expect(await markHeldTicketsValid([TICKET_ID, 'tkt_2'], at)).toBe(rows);
    expect(dbMock.argsOf('set')[0]).toEqual({
      status: 'valid',
      purchasedAt: at,
      paymentConfirmedAt: at,
      heldBy: null,
      heldUntil: null,
      holdExpiresAt: null,
    });
    expect(renderedWhere().params).toEqual([TICKET_ID, 'tkt_2', 'held']);
  });

  it('markTicketsRefunded flags the given ids', async () => {
    await markTicketsRefunded([TICKET_ID]);

    expect(dbMock.argsOf('set')[0]).toEqual({ status: 'refunded' });
    expect(renderedWhere().params).toEqual([TICKET_ID]);
  });

  it('cancelTicketRow cancels, drops the hold and returns the row', async () => {
    const cancelled = makeTicket({ status: 'cancelled' });
    dbMock.queue([cancelled]);

    expect(await cancelTicketRow(TICKET_ID)).toBe(cancelled);
    expect(dbMock.argsOf('set')[0]).toEqual({ status: 'cancelled', heldBy: null, heldUntil: null });
    expect(renderedWhere().params).toEqual([TICKET_ID]);
  });

  it('releaseExpiredHolds frees lapsed holds of one ticket type', async () => {
    const now = new Date('2026-01-01T00:00:00Z');

    await releaseExpiredHolds(TYPE_ID, now);

    expect(dbMock.argsOf('set')[0]).toEqual({ status: 'available', heldBy: null, heldUntil: null });
    expect(renderedWhere().params).toEqual([TYPE_ID, 'held', now.toISOString()]);
  });
});

describe('raw refund-state queries', () => {
  it('loadRefundableTicket selects by id + event', async () => {
    dbMock.queueSql([ROW]);

    expect(await loadRefundableTicket(EVENT_ID, TICKET_ID)).toBe(ROW);
    expect(dbMock.argsOf('sql')).toEqual([
      expect.stringContaining('FROM events.tickets WHERE id = ? AND event_id = ?'),
      TICKET_ID,
      EVENT_ID,
    ]);
  });

  it('loadRefundableTicket returns null when nothing matches', async () => {
    dbMock.queueSql([]);

    expect(await loadRefundableTicket(EVENT_ID, 'tkt_missing')).toBeNull();
  });

  it('setTicketRefundStatus updates the status and returns { id, status }', async () => {
    dbMock.queueSql([{ id: TICKET_ID, status: 'refund_pending' }]);

    expect(await setTicketRefundStatus(TICKET_ID, 'refund_pending')).toEqual({
      id: TICKET_ID,
      status: 'refund_pending',
    });
    expect(dbMock.argsOf('sql')).toEqual([
      expect.stringContaining('UPDATE events.tickets SET status = ?'),
      'refund_pending',
      TICKET_ID,
    ]);
  });

  it('findTicketStatus selects id/status by id + event, or null', async () => {
    dbMock.queueSql([ROW]);
    expect(await findTicketStatus(EVENT_ID, TICKET_ID)).toBe(ROW);
    expect(dbMock.argsOf('sql')[0]).toContain('SELECT id, status FROM events.tickets');

    dbMock.queueSql([]);
    expect(await findTicketStatus(EVENT_ID, 'tkt_missing')).toBeNull();
  });

  it('markRefundSentRow flips to refunded', async () => {
    dbMock.queueSql([{ id: TICKET_ID, status: 'refunded' }]);

    expect(await markRefundSentRow(TICKET_ID)).toEqual({ id: TICKET_ID, status: 'refunded' });
    expect(dbMock.argsOf('sql')[0]).toContain("SET status = 'refunded'");
  });
});
