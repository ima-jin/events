import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_ID, dbChain, makeTier } from '../support/ticket-types-support';

vi.mock('@/db', async (importOriginal) =>
  (await import('../support/ticket-types-support')).mockDbModule(importOriginal as never),
);

import {
  getTicketTypeForEvent,
  insertTicketType,
  listPublicTicketTypes,
  listTicketTypeCurrencies,
  listTicketTypesByAccessCode,
  updateTicketType,
} from '@/repositories/ticket-types-repository';

const { methods } = dbChain;

beforeEach(() => {
  vi.clearAllMocks();
  dbChain.resolveWith([]);
});

describe('ticket types repository — reads', () => {
  it('lists public tiers ordered for display', async () => {
    const rows = [makeTier(), makeTier({ id: 'tkt_type_2' })];
    dbChain.resolveWith(rows);

    expect(await listPublicTicketTypes(EVENT_ID)).toEqual(rows);
    expect(methods.where).toHaveBeenCalledTimes(1);
    expect(methods.orderBy).toHaveBeenCalledTimes(1);
  });

  it('lists tiers matching an access code, ordered for display', async () => {
    const rows = [makeTier({ accessCode: 'VIP' })];
    dbChain.resolveWith(rows);

    expect(await listTicketTypesByAccessCode(EVENT_ID, 'vip')).toEqual(rows);
    expect(methods.where).toHaveBeenCalledTimes(1);
    expect(methods.orderBy).toHaveBeenCalledTimes(1);
  });

  it('lists one currency per tier', async () => {
    dbChain.resolveWith([{ currency: 'CAD' }, { currency: 'USD' }]);

    expect(await listTicketTypeCurrencies(EVENT_ID)).toEqual(['CAD', 'USD']);
  });

  it('returns a tier of the event, or null when there is none', async () => {
    const tier = makeTier();
    dbChain.resolveWith([tier]);
    expect(await getTicketTypeForEvent(tier.id, EVENT_ID)).toEqual(tier);
    expect(methods.limit).toHaveBeenCalledWith(1);

    dbChain.resolveWith([]);
    expect(await getTicketTypeForEvent('tkt_type_missing', EVENT_ID)).toBeNull();
  });

  it('propagates database failures', async () => {
    dbChain.rejectWith(new Error('db down'));

    await expect(listPublicTicketTypes(EVENT_ID)).rejects.toThrow('db down');
  });
});

describe('ticket types repository — writes', () => {
  it('inserts a tier and returns the stored row', async () => {
    const tier = makeTier();
    dbChain.resolveWith([tier]);

    expect(await insertTicketType({ id: tier.id, eventId: EVENT_ID, name: tier.name, price: tier.price })).toEqual(tier);
    expect(methods.values).toHaveBeenCalledWith({ id: tier.id, eventId: EVENT_ID, name: tier.name, price: tier.price });
    expect(methods.returning).toHaveBeenCalledTimes(1);
  });

  it('updates a tier and returns the stored row', async () => {
    const tier = makeTier({ name: 'Renamed' });
    dbChain.resolveWith([tier]);

    expect(await updateTicketType(tier.id, { name: 'Renamed' })).toEqual(tier);
    expect(methods.set).toHaveBeenCalledWith({ name: 'Renamed' });
    expect(methods.returning).toHaveBeenCalledTimes(1);
  });
});
