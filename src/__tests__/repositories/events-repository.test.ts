import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleChain, dbMock, makeEventRow, makeTicketTypeRow } from '../support/events-support';

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  db: (await import('../support/events-support')).dbMock,
}));

import * as repo from '@/repositories/events-repository';

const EVENT = makeEventRow();
const TICKET_TYPE = makeTicketTypeRow();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('single-row lookups', () => {
  it.each([
    ['getEventOwnership', () => repo.getEventOwnership('evt_1'), { creatorDid: 'did:imajin:c', podId: null }],
    ['getEventById', () => repo.getEventById('evt_1'), EVENT],
    ['getEventSummaryByDid', () => repo.getEventSummaryByDid('did:imajin:event123'), { id: 'evt_1', title: 'T', did: 'd' }],
  ])('%s returns the first row, limited to one', async (_name, run, row) => {
    const chain = createDrizzleChain([row]);
    dbMock.select.mockReturnValue(chain);

    expect(await run()).toBe(row);
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it.each([
    ['getEventOwnership', () => repo.getEventOwnership('evt_x')],
    ['getEventById', () => repo.getEventById('evt_x')],
    ['getEventSummaryByDid', () => repo.getEventSummaryByDid('did:none')],
  ])('%s returns null when nothing matches', async (_name, run) => {
    dbMock.select.mockReturnValue(createDrizzleChain([]));

    expect(await run()).toBeNull();
  });
});

describe('listEvents', () => {
  it('filters by status only and orders newest first', async () => {
    const chain = createDrizzleChain([EVENT]);
    dbMock.select.mockReturnValue(chain);

    expect(await repo.listEvents({ status: 'published', limit: 20 })).toEqual([EVENT]);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it('adds the course and upcoming conditions when requested', async () => {
    const plain = createDrizzleChain([]);
    const filtered = createDrizzleChain([EVENT]);
    dbMock.select.mockReturnValueOnce(plain).mockReturnValueOnce(filtered);

    await repo.listEvents({ status: 'published', limit: 5 });
    expect(await repo.listEvents({ status: 'published', limit: 5, courseSlug: 'intro', upcoming: true })).toEqual([EVENT]);

    // upcoming events sort soonest-first (asc), everything else newest-first (desc)
    const orderOf = (chain: typeof plain) => (chain.orderBy.mock.calls[0][0] as { queryChunks: unknown[] }).queryChunks;
    expect(orderOf(filtered)).not.toEqual(orderOf(plain));
    expect(filtered.where).toHaveBeenCalledTimes(1);
  });
});

describe('listEventsByCreator / listTicketTypesForEvent', () => {
  it('lists a creator\'s events newest first', async () => {
    const chain = createDrizzleChain([EVENT]);
    dbMock.select.mockReturnValue(chain);

    expect(await repo.listEventsByCreator('did:imajin:creator')).toEqual([EVENT]);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('lists the ticket types of an event', async () => {
    const chain = createDrizzleChain([TICKET_TYPE]);
    dbMock.select.mockReturnValue(chain);

    expect(await repo.listTicketTypesForEvent('evt_1')).toEqual([TICKET_TYPE]);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

describe('writes', () => {
  it('insertEvent stores the values and returns the created row', async () => {
    const chain = createDrizzleChain([EVENT]);
    dbMock.insert.mockReturnValue(chain);

    const values = { id: 'evt_1', did: 'd', publicKey: 'pk', title: 'T', startsAt: new Date(), creatorDid: 'did:imajin:creator' };
    expect(await repo.insertEvent(values)).toBe(EVENT);
    expect(chain.values).toHaveBeenCalledWith(values);
  });

  it('insertTicketTypes stores every row and returns the created rows', async () => {
    const chain = createDrizzleChain([TICKET_TYPE]);
    dbMock.insert.mockReturnValue(chain);

    const values = [{ id: 'tkt_type_1', eventId: 'evt_1', name: 'General', price: 2000 }];
    expect(await repo.insertTicketTypes(values)).toEqual([TICKET_TYPE]);
    expect(chain.values).toHaveBeenCalledWith(values);
  });

  it('updateEventById applies the update and returns the stored row', async () => {
    const chain = createDrizzleChain([EVENT]);
    dbMock.update.mockReturnValue(chain);

    expect(await repo.updateEventById('evt_1', { title: 'New' })).toBe(EVENT);
    expect(chain.set).toHaveBeenCalledWith({ title: 'New' });
  });

  it('updateEventById returns undefined when no row matched', async () => {
    dbMock.update.mockReturnValue(createDrizzleChain([]));

    expect(await repo.updateEventById('evt_x', { title: 'New' })).toBeUndefined();
  });
});
