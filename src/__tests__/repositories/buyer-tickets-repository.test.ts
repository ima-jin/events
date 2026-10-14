import { beforeEach, describe, expect, it } from 'vitest';
import { nextSelect, resetDbMocks, selectMock, whereParams } from '../support/db-queue-support';
import { EVENT_ID, OWNER_DID } from '../support/ticket-access-support';
import { buyerRow } from '../support/buyer-tickets-support';
import { getBuyerEventAccess, listOwnedTicketRows } from '@/repositories/buyer-tickets-repository';

beforeEach(resetDbMocks);

describe('buyer tickets repository', () => {
  it('reads only the current owner in the requested event, with allowlisted columns', async () => {
    const rows = [buyerRow()];
    nextSelect(rows);

    expect(await listOwnedTicketRows(EVENT_ID, OWNER_DID)).toEqual(rows);
    expect(whereParams(0)).toEqual([EVENT_ID, OWNER_DID]);
    const fields = selectMock.mock.calls[0][0] as Record<string, Record<string, unknown>>;
    expect(Object.keys(fields.ticket)).toEqual([
      'id', 'orderId', 'status', 'usedAt', 'registrationStatus', 'purchasedAt', 'createdAt',
      'pricePaid', 'currency', 'legacyFairSettlement',
    ]);
    expect(Object.keys(fields.order)).toEqual(['id', 'buyerDid', 'quantity', 'amountTotal', 'currency', 'fairSettlement']);
    expect(Object.keys(fields.ticketType)).toEqual(['id', 'name', 'description', 'perks', 'registrationFormId']);
  });

  it('reads only event ownership and pod for the unchanged access check', async () => {
    nextSelect([{ creatorDid: OWNER_DID, podId: null }]);
    expect(await getBuyerEventAccess(EVENT_ID)).toEqual({ creatorDid: OWNER_DID, podId: null });
    expect(whereParams(0)).toEqual([EVENT_ID]);
    nextSelect([]);
    expect(await getBuyerEventAccess(EVENT_ID)).toBeNull();
  });

  it('propagates database failures', async () => {
    nextSelect(new Error('db unavailable'));
    await expect(listOwnedTicketRows(EVENT_ID, OWNER_DID)).rejects.toThrow('db unavailable');
  });
});
