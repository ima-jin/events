import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  TYPE_ID,
  dbMock,
  makeTicketType,
  renderSql,
  renderedWhere,
} from '@/__tests__/support/orders-support';

vi.mock('@/db', async (importOriginal) =>
  (await import('@/__tests__/support/orders-support')).dbModuleMock(importOriginal),
);

import {
  decrementSold,
  findTicketTypesByEvent,
  findTicketTypesByIds,
  incrementSold,
} from '@/repositories/ticket-types-repository';

beforeEach(() => dbMock.reset());

describe('ticket type lookups', () => {
  it('findTicketTypesByEvent filters by event', async () => {
    const rows = [makeTicketType()];
    dbMock.queue(rows);

    expect(await findTicketTypesByEvent(EVENT_ID)).toBe(rows);
    expect(renderedWhere().params).toEqual([EVENT_ID]);
  });

  it('findTicketTypesByIds filters by id list', async () => {
    const rows = [makeTicketType()];
    dbMock.queue(rows);

    expect(await findTicketTypesByIds([TYPE_ID, 'type_2'])).toBe(rows);
    expect(renderedWhere().params).toEqual([TYPE_ID, 'type_2']);
  });
});

describe('sold counter', () => {
  it('incrementSold adds the count to the type', async () => {
    await incrementSold(TYPE_ID, 3);

    const { sold } = dbMock.argsOf('set')[0] as { sold: unknown };
    const rendered = renderSql(sold);
    expect(rendered.sql).toContain('+');
    expect(rendered.params).toEqual([3]);
    expect(renderedWhere().params).toEqual([TYPE_ID]);
  });

  it('decrementSold subtracts the count but never below zero', async () => {
    await decrementSold(TYPE_ID, 2);

    const { sold } = dbMock.argsOf('set')[0] as { sold: unknown };
    const rendered = renderSql(sold);
    expect(rendered.sql).toContain('GREATEST(');
    expect(rendered.params).toEqual([2]);
    expect(renderedWhere().params).toEqual([TYPE_ID]);
  });
});
