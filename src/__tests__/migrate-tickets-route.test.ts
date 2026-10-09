/**
 * POST /api/migrate-tickets — moves tickets bought with a soft DID onto the
 * buyer's hard DID. Auth is a scoped app token (`events:write`), failing closed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_DID,
  accessRequest,
  resetTicketAccessMocks,
} from './support/ticket-access-support';
import { nextSelect, nextUpdate, selectMock, setValues, updateMock, updatedTables, whereParams } from './support/db-queue-support';
import { chatUrl, fetchMock, getIdentityTierMock, setChatUrl } from './support/kernel-mock-support';
import { appAuthSuccess, mockLog, requireAppAuthMock } from './support/route-test-support';
import { tickets } from '@/db';
import { POST } from '../../app/api/migrate-tickets/route';

const HARD_DID = 'did:imajin:hard';
const SOFT_A = 'did:imajin:soft-a';
const SOFT_B = 'did:imajin:soft-b';
const HARD_OTHER = 'did:imajin:hard-other';
const EMAIL = 'buyer@example.com';
const ERR_MIGRATION_FAILED = 'Migration failed';

const migrate = (body: unknown = { email: EMAIL, hardDid: HARD_DID }) =>
  POST(accessRequest('/api/migrate-tickets', { method: 'POST', body }));

function tierLookup(tiers: Record<string, string | null>): void {
  getIdentityTierMock.mockImplementation(async (did: string) => tiers[did] ?? null);
}

beforeEach(() => {
  resetTicketAccessMocks();
  requireAppAuthMock.mockResolvedValue(appAuthSuccess(OWNER_DID, ['events:write']));
});

describe('POST /api/migrate-tickets', () => {
  it('requires an app token carrying events:write', async () => {
    nextSelect([]);

    await migrate();

    expect(requireAppAuthMock).toHaveBeenCalledWith(expect.any(Request), { scope: 'events:write' });
  });

  it.each([
    [401, 'Invalid app token'],
    [403, 'Missing scope: events:write'],
  ])('fails closed with %i when app auth is rejected', async (status, error) => {
    requireAppAuthMock.mockResolvedValue({ error, status });

    const res = await migrate();

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['email is', { hardDid: HARD_DID }],
    ['hardDid is', { email: EMAIL }],
    ['both are', {}],
  ])('answers 400 when %s missing', async (_label, body) => {
    const res = await migrate(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'email and hardDid are required' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('answers 500 for a malformed JSON body', async () => {
    const res = await POST(accessRequest('/api/migrate-tickets', { method: 'POST', body: undefined }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_MIGRATION_FAILED });
    expect(mockLog.error).toHaveBeenCalledWith({ err: expect.any(String) }, 'migrate-tickets error');
  });

  it('matches tickets on the normalised purchase email and the hard DID', async () => {
    nextSelect([]);

    await migrate({ email: '  Buyer@Example.COM ', hardDid: HARD_DID });

    expect(whereParams(0)).toEqual([EMAIL, HARD_DID]);
  });

  it('reports 0 when no ticket was bought with that email', async () => {
    nextSelect([]);

    const res = await migrate();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migrated: 0 });
    expect(mockLog.info).toHaveBeenCalledWith({ email: EMAIL, hardDid: HARD_DID }, 'No soft DID tickets to migrate');
    expect(getIdentityTierMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('never re-migrates tickets already owned by the hard DID', async () => {
    nextSelect([{ id: 't1', ownerDid: HARD_DID }]);

    const res = await migrate();

    expect(await res.json()).toEqual({ migrated: 0 });
    expect(getIdentityTierMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('leaves tickets owned by other hard identities alone', async () => {
    nextSelect([{ id: 't1', ownerDid: HARD_OTHER }]);
    tierLookup({ [HARD_OTHER]: 'hard' });

    const res = await migrate();

    expect(await res.json()).toEqual({ migrated: 0 });
    expect(getIdentityTierMock).toHaveBeenCalledWith(HARD_OTHER);
    expect(updateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('migrates soft and unknown-tier tickets, once per distinct owner lookup', async () => {
    nextSelect([
      { id: 't1', ownerDid: SOFT_A },
      { id: 't2', ownerDid: SOFT_A },
      { id: 't3', ownerDid: SOFT_B },
      { id: 't4', ownerDid: HARD_OTHER },
      { id: 't5', ownerDid: null },
    ]);
    tierLookup({ [SOFT_A]: 'soft', [HARD_OTHER]: 'hard' });

    const res = await migrate();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migrated: 3 });
    expect(getIdentityTierMock.mock.calls.map(([did]) => did)).toEqual([SOFT_A, SOFT_B, HARD_OTHER]);
    expect(updatedTables()).toEqual([tickets]);
    expect(setValues()).toEqual([{ ownerDid: HARD_DID }]);
    expect(whereParams(1)).toEqual(['t1', 't2', 't3']);
    expect(mockLog.info).toHaveBeenCalledWith(
      { count: 3, softDids: [SOFT_A, SOFT_B], hardDid: HARD_DID, email: EMAIL },
      'Migrated tickets from soft DIDs to hard DID',
    );
  });

  it("moves each soft DID's chat participation to the hard DID", async () => {
    nextSelect([
      { id: 't1', ownerDid: SOFT_A },
      { id: 't2', ownerDid: SOFT_B },
    ]);

    await migrate();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([`${chatUrl}/api/participants/migrate`, `${chatUrl}/api/participants/migrate`]);
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'POST']);
    expect(calls.map(([, init]) => JSON.parse(init.body as string))).toEqual([
      { fromDid: SOFT_A, toDid: HARD_DID },
      { fromDid: SOFT_B, toDid: HARD_DID },
    ]);
    expect(mockLog.info).toHaveBeenCalledWith({ softDid: SOFT_A, hardDid: HARD_DID }, 'Migrated chat participation');
  });

  it('skips chat migration when no chat service is configured', async () => {
    setChatUrl(null);
    nextSelect([{ id: 't1', ownerDid: SOFT_A }]);

    const res = await migrate();

    expect(await res.json()).toEqual({ migrated: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a chat migration failure as non-fatal', async () => {
    nextSelect([{ id: 't1', ownerDid: SOFT_A }]);
    fetchMock.mockRejectedValue(new Error('chat down'));

    const res = await migrate();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ migrated: 1 });
    expect(mockLog.warn).toHaveBeenCalledWith(
      { softDid: SOFT_A, err: 'Error: chat down' },
      'Chat migration failed (non-fatal)',
    );
  });

  it('answers 500 when the ticket lookup fails', async () => {
    nextSelect(new Error('boom'));

    const res = await migrate();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_MIGRATION_FAILED });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'migrate-tickets error');
  });

  it('answers 500 when the ownership update fails, and does not touch chat', async () => {
    nextSelect([{ id: 't1', ownerDid: SOFT_A }]);
    nextUpdate(new Error('boom'));

    const res = await migrate();

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
