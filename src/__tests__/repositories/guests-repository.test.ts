import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqlMock, drizzleChain, EVENT_ID, exportRow, OWNER_DID, ticketRow } from '../support/guests-support';

const mocks = vi.hoisted(() => ({ select: vi.fn(), sqlHolder: { sql: undefined as unknown } }));
const sqlMock = createSqlMock();
mocks.sqlHolder.sql = sqlMock.sql;

vi.mock('@/db', async () => ({
  ...(await vi.importActual<typeof import('@/db/schema')>('@/db/schema')),
  db: { select: mocks.select },
  getClient: () => mocks.sqlHolder.sql,
}));

import {
  getEventTitle,
  listCreatedEvents,
  listGuestExportRows,
  listGuestTicketRows,
  listHeldEventIds,
  listPodEvents,
  listTicketedEvents,
} from '@/repositories/guests-repository';

const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(() => {
  sqlMock.reset();
  mocks.select.mockReset();
});

describe('guest ticket queries (raw SQL)', () => {
  it('lists every ticket of the event newest first', async () => {
    sqlMock.queue([ticketRow()]);

    expect(await listGuestTicketRows(EVENT_ID)).toEqual([ticketRow()]);
    expect(sqlMock.calls[0].text).toContain('FROM events.tickets t');
    expect(sqlMock.calls[0].text).toContain('ORDER BY t.created_at DESC');
    expect(sqlMock.calls[0].values).toEqual([EVENT_ID]);
  });

  it('looks up an event title, or null when the event is missing', async () => {
    sqlMock.queue([{ id: EVENT_ID, title: 'Gala' }]);
    expect(await getEventTitle(EVENT_ID)).toEqual({ id: EVENT_ID, title: 'Gala' });

    sqlMock.queue([]);
    expect(await getEventTitle(EVENT_ID)).toBeNull();
  });

  it('adds the cancelled/refunded filter unless includeCancelled is set', async () => {
    sqlMock.queue([exportRow()]);
    expect(await listGuestExportRows(EVENT_ID, false)).toEqual([exportRow()]);
    expect(sqlMock.calls[0].values[1]).toEqual({ fragment: "AND t.status NOT IN ('cancelled', 'refunded')" });

    sqlMock.queue([]);
    await listGuestExportRows(EVENT_ID, true);
    expect(sqlMock.calls[1].values[1]).toEqual({ fragment: '' });
  });

  it('maps pod event records to attending rows', async () => {
    sqlMock.queue([
      { event_id: 'e1', title: 'A', starts_at: '2026-07-01T00:00:00.000Z', ends_at: '2026-07-01T02:00:00.000Z', venue: 'Hall', access_mode: 'public', image_url: 'x.png' },
      { event_id: 'e2', title: 'B', starts_at: new Date('2026-08-01T00:00:00.000Z'), ends_at: null, venue: null, access_mode: 'invite_only', image_url: null },
    ]);

    const rows = await listPodEvents(['pod_1'], NOW);

    expect(sqlMock.calls[0].values).toEqual([['pod_1'], NOW.toISOString()]);
    expect(rows).toEqual([
      { eventId: 'e1', title: 'A', startsAt: new Date('2026-07-01T00:00:00.000Z'), endsAt: new Date('2026-07-01T02:00:00.000Z'), venue: 'Hall', accessMode: 'public', imageUrl: 'x.png' },
      { eventId: 'e2', title: 'B', startsAt: new Date('2026-08-01T00:00:00.000Z'), endsAt: null, venue: null, accessMode: 'invite_only', imageUrl: null },
    ]);
  });
});

describe('attending queries (drizzle)', () => {
  it('lists ticketed events through a tickets→events join', async () => {
    const chain = drizzleChain([{ eventId: 'e1' }]);
    mocks.select.mockReturnValue(chain);

    expect(await listTicketedEvents(OWNER_DID, NOW)).toEqual([{ eventId: 'e1' }]);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('lists created events without a join', async () => {
    const chain = drizzleChain([{ eventId: 'e2' }]);
    mocks.select.mockReturnValue(chain);

    expect(await listCreatedEvents(OWNER_DID, NOW)).toEqual([{ eventId: 'e2' }]);
    expect(chain.innerJoin).not.toHaveBeenCalled();
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('returns just the event ids the viewer holds tickets for', async () => {
    mocks.select.mockReturnValue(drizzleChain([{ eventId: 'e1' }, { eventId: 'e3' }]));

    expect(await listHeldEventIds('did:imajin:viewer', ['e1', 'e2', 'e3'])).toEqual(['e1', 'e3']);
  });
});
