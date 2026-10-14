import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createDrizzleChain, dbMock, makeEventRow } from './support/events-support';

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  db: (await import('./support/events-support')).dbMock,
}));

import { attachEventPodIfMissing } from '@/repositories/events-repository';

beforeEach(() => vi.clearAllMocks());

describe('attachEventPodIfMissing', () => {
  it('only updates an event with a null pod, atomically', async () => {
    const event = makeEventRow({ podId: 'pod_new' });
    const chain = createDrizzleChain([event]);
    dbMock.update.mockReturnValue(chain);
    expect(await attachEventPodIfMissing(event.id, 'pod_new')).toBe(event);
    expect(chain.set).toHaveBeenCalledWith({ podId: 'pod_new' });
    const predicate = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"pod_id" is null');
    expect(predicate.params).toContain(event.id);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rereads and returns the concurrent winner without overwriting its pod', async () => {
    const winner = makeEventRow({ podId: 'pod_winner' });
    dbMock.update.mockReturnValue(createDrizzleChain([]));
    dbMock.select.mockReturnValue(createDrizzleChain([winner]));
    expect(await attachEventPodIfMissing(winner.id, 'pod_loser')).toBe(winner);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('returns null if the event vanished during initialization', async () => {
    dbMock.update.mockReturnValue(createDrizzleChain([]));
    dbMock.select.mockReturnValue(createDrizzleChain([]));
    expect(await attachEventPodIfMissing('missing', 'pod_new')).toBeNull();
  });
});
