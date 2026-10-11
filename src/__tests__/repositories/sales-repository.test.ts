import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminEventRow,
  createSqlMock,
  EVENT_ID,
  exportOrderRow,
  orderSaleRow,
  orphanRow,
  salesEvent,
  ticketStatusRow,
} from '../support/sales-support';

const mocks = vi.hoisted(() => ({ sqlHolder: { sql: undefined as unknown } }));
const sqlMock = createSqlMock();
mocks.sqlHolder.sql = sqlMock.sql;

vi.mock('@/db', () => ({ getClient: () => mocks.sqlHolder.sql }));

import {
  getSalesEvent,
  listAdminEventRows,
  listExportOrderRows,
  listOrderSaleRows,
  listOrphanTicketRows,
  listTicketStatusRows,
} from '@/repositories/sales-repository';

beforeEach(() => {
  sqlMock.reset();
  mocks.sqlHolder.sql = sqlMock.sql;
});

describe('sales event lookup', () => {
  it('returns the event row, or null when it is missing', async () => {
    sqlMock.queue([salesEvent()]);
    expect(await getSalesEvent(EVENT_ID)).toEqual(salesEvent());
    expect(sqlMock.calls[0].text).toContain('FROM events.events');
    expect(sqlMock.calls[0].values).toEqual([EVENT_ID]);

    sqlMock.queue([]);
    expect(await getSalesEvent(EVENT_ID)).toBeNull();
  });
});

describe.each([
  ['listOrderSaleRows', listOrderSaleRows, orderSaleRow(), 'FROM events.orders o', 'ORDER BY o.created_at DESC, t.created_at ASC'],
  ['listOrphanTicketRows', listOrphanTicketRows, orphanRow(), 'AND t.order_id IS NULL', 'ORDER BY t.purchased_at DESC NULLS LAST'],
  ['listExportOrderRows', listExportOrderRows, exportOrderRow(), 'JOIN events.ticket_types tt', 'ORDER BY o.purchased_at DESC NULLS LAST'],
  ['listTicketStatusRows', listTicketStatusRows, ticketStatusRow(), 'FROM events.tickets', 'WHERE event_id = ?'],
])('%s', (_name, list, row, fromClause, orderClause) => {
  it('queries this event only, in the events schema, returning the rows untouched', async () => {
    sqlMock.queue([row]);

    expect(await list(EVENT_ID)).toEqual([row]);
    expect(sqlMock.calls).toHaveLength(1);
    expect(sqlMock.calls[0].values).toEqual([EVENT_ID]);
    expect(sqlMock.calls[0].text).toContain(fromClause);
    expect(sqlMock.calls[0].text).toContain(orderClause);
  });
});

describe('listAdminEventRows', () => {
  it('aggregates tickets, currencies and ticket types per event, newest first', async () => {
    // The overview query has no interpolated values, which the shared sql mock treats as a fragment.
    let text = '';
    mocks.sqlHolder.sql = (strings: TemplateStringsArray) => {
      text = strings.join('');
      return Promise.resolve([adminEventRow()]);
    };

    expect(await listAdminEventRows()).toEqual([adminEventRow()]);
    expect(text).toContain('WITH ticket_stats AS');
    expect(text).toContain('ORDER BY e.created_at DESC');
  });
});
