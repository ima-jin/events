import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buyerRow, fairReceipt, ORDER_ID, PURCHASED_AT } from '../support/buyer-tickets-support';
import { EVENT_ID, OWNER_DID, resetTicketAccessMocks } from '../support/ticket-access-support';
import { isPodMemberMock } from '../support/kernel-mock-support';
import type { BuyerTicketRow } from '@/repositories/buyer-tickets-repository';

const repo = vi.hoisted(() => ({ listOwnedTicketRows: vi.fn(), getBuyerEventAccess: vi.fn() }));
vi.mock('@/repositories/buyer-tickets-repository', () => repo);

import { getBuyerTickets } from '@/services/buyer-tickets-service';

const read = () => getBuyerTickets(EVENT_ID, OWNER_DID, null);
function arrange(rows: BuyerTicketRow[]) {
  repo.listOwnedTicketRows.mockResolvedValue(rows);
}
beforeEach(() => {
  resetTicketAccessMocks();
  repo.listOwnedTicketRows.mockReset().mockResolvedValue([]);
  repo.getBuyerEventAccess.mockReset().mockResolvedValue(null);
  vi.stubEnv('DYKIL_URL', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('buyer ticket projection', () => {
  it('groups mixed ticket types, retains every owned status and keeps the flat response', async () => {
    const order = { quantity: 3, amountTotal: 7500, fairSettlement: fairReceipt() };
    arrange([
      buyerRow({ registrationStatus: 'complete', usedAt: new Date(PURCHASED_AT), status: 'used' }, {}, order),
      buyerRow({ id: 'tkt_2', status: 'held' }, { name: 'Bunkie' }, order),
      buyerRow({ id: 'tkt_3', status: 'refunded' }, { name: 'Bunkie' }, order),
    ]);

    const result = await read();

    expect(repo.listOwnedTicketRows).toHaveBeenCalledWith(EVENT_ID, OWNER_DID);
    expect(result.orders).toEqual([{
      id: ORDER_ID, isLegacy: false, quantity: 3, totalAmount: 7500, currency: 'CAD',
      purchasedAt: PURCHASED_AT, ticketTypeName: 'VIP + 2× Bunkie', fairSettlement: fairReceipt(),
      tickets: [
        expect.objectContaining({ id: 'tkt_1', status: 'used', usedAt: PURCHASED_AT, registrationStatus: 'complete' }),
        expect.objectContaining({ id: 'tkt_2', status: 'held', registrationStatus: 'pending' }),
        expect.objectContaining({ id: 'tkt_3', status: 'refunded' }),
      ],
    }]);
    expect(result.tickets[0]).toEqual({
      id: 'tkt_1', status: 'used', purchasedAt: PURCHASED_AT, pricePaid: 2500, currency: 'CAD',
      ticketType: { name: 'VIP', description: 'Front row', perks: ['drink'] },
    });
    expect(result.orders[0].tickets[0].ticketType?.registrationFormId).toBe('form_1');
    expect(JSON.stringify(result)).not.toContain('qrCode');
  });

  it('keeps legacy tickets in separate groups with their own receipt and timestamp fallback', async () => {
    arrange([
      buyerRow({ orderId: null, legacyFairSettlement: fairReceipt(), purchasedAt: null, createdAt: new Date(PURCHASED_AT) }, null, null),
      buyerRow({ id: 'tkt_2', orderId: null, purchasedAt: null, pricePaid: 0, registrationStatus: '' }, {}, null),
    ]);
    const { orders } = await read();
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ id: 'tkt_1', isLegacy: true, quantity: 1, ticketTypeName: 'Ticket', purchasedAt: PURCHASED_AT, fairSettlement: fairReceipt() });
    expect(orders[0].tickets[0].ticketType).toBeNull();
    expect(orders[1]).toMatchObject({ id: 'tkt_2', totalAmount: 0, purchasedAt: null });
    expect(orders[1].tickets[0].registrationStatus).toBe('not_required');
  });

  it.each([
    ['partial purchase after transfer', { quantity: 2 }],
    ['transferred recipient', { buyerDid: 'did:imajin:original-buyer' }],
  ])('hides original order totals and receipts for a %s', async (_label, order) => {
    arrange([buyerRow({}, {}, { amountTotal: 10000, fairSettlement: fairReceipt({ totalAmount: 100 }), ...order })]);
    expect((await read()).orders[0]).toMatchObject({ quantity: 1, totalAmount: 2500, fairSettlement: null });
  });

  it('does not invent unknown or mixed-currency totals when the order row is absent', async () => {
    arrange([buyerRow({ pricePaid: null }, {}, null)]);
    expect((await read()).orders[0]).toMatchObject({ totalAmount: null, currency: null });
    arrange([buyerRow({}, {}, null), buyerRow({ id: 'tkt_2', currency: 'USD' }, {}, null)]);
    expect((await read()).orders[0]).toMatchObject({ quantity: 2, totalAmount: null, currency: null, fairSettlement: null });
  });

  it('allowlists nested receipt and ticket-type fields without leaking raw metadata or identifiers', async () => {
    const receipt = fairReceipt({
      paymentId: 'private-payment', email: 'buyer@example.com', metadata: { secret: 'private-token' },
      chain: [{ did: 'did:imajin:seller', amount: 24, role: 'seller', secret: 'private-token' }],
      fees: [{ ...fairReceipt().fees![0], secret: 'private-token' }],
    });
    arrange([buyerRow({}, { perks: ['drink', { secret: 'private-token' }] }, { fairSettlement: receipt })]);
    const result = await read();
    expect(result.orders[0].fairSettlement).toEqual(fairReceipt());
    expect(result.orders[0].tickets[0].ticketType?.perks).toEqual(['drink']);
    const serialized = JSON.stringify(result);
    for (const privateValue of ['private-payment', 'buyer@example.com', 'private-token', 'buyerDid', 'metadata']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    null, [], 'receipt',
    fairReceipt({ totalAmount: Number.NaN }),
    fairReceipt({ totalAmount: -1 }),
    fairReceipt({ netAmount: '24' }),
    fairReceipt({ settledAt: 'invalid' }),
    fairReceipt({ currency: 'not-currency' }),
    fairReceipt({ version: {} }),
    fairReceipt({ chain: [{ did: 'email@example.com', role: 'seller', amount: 24 }] }),
    fairReceipt({ chain: [{ did: 'did:imajin:seller', role: 'seller', amount: Number.POSITIVE_INFINITY }] }),
    fairReceipt({ chain: {} }),
    fairReceipt({ fees: {} }),
    fairReceipt({ fees: [{ ...fairReceipt().fees![0], estimated: 'yes' }] }),
    fairReceipt({ fees: [{ ...fairReceipt().fees![0], amount: -1 }] }),
  ])('rejects malformed receipt %# rather than returning unsafe JSON', async (receipt) => {
    arrange([buyerRow({}, {}, { fairSettlement: receipt })]);
    expect((await read()).orders[0].fairSettlement).toBeNull();
  });

  it('prefers the order receipt; falls back only when the order snapshot is absent', async () => {
    const legacy = fairReceipt({ totalAmount: 50 });
    arrange([buyerRow({ legacyFairSettlement: legacy }, {}, { fairSettlement: fairReceipt() })]);
    expect((await read()).orders[0].fairSettlement).toEqual(fairReceipt());
    arrange([buyerRow({ legacyFairSettlement: legacy })]);
    expect((await read()).orders[0].fairSettlement).toEqual(legacy);
    arrange([buyerRow({ legacyFairSettlement: legacy }, {}, { fairSettlement: { bad: true } })]);
    expect((await read()).orders[0].fairSettlement).toBeNull();
  });

  it.each([
    ['https://dykil.test/base/?token=remove#remove', 'https://dykil.test/base'],
    ['http://localhost:3001/', 'http://localhost:3001'],
    ['', null],
    ['invalid', null],
    ['javascript:alert(1)', null],
    ['https://user:password@dykil.test', null],
  ])('returns only a sanitized configured public registration base for %s', async (value, expected) => {
    vi.stubEnv('DYKIL_URL', value);
    expect((await read()).registrationEmbedBaseUrl).toBe(expected);
  });

  it('preserves creator and pod access with the existing role allowlist', async () => {
    repo.getBuyerEventAccess.mockResolvedValue({ creatorDid: OWNER_DID, podId: 'pod_1' });
    expect(await read()).toMatchObject({ hasTicket: false, hasAccess: true, isOrganizer: true, orders: [] });
    expect(isPodMemberMock).not.toHaveBeenCalled();
    repo.getBuyerEventAccess.mockResolvedValue({ creatorDid: 'did:imajin:other', podId: 'pod_1' });
    isPodMemberMock.mockResolvedValue(true);
    expect(await read()).toMatchObject({ hasTicket: false, hasAccess: true, isOrganizer: true, orders: [] });
    expect(isPodMemberMock).toHaveBeenCalledWith('pod_1', OWNER_DID, ['owner', 'host', 'cohost'], null);
  });

  it('retains the compatibility cookie without changing the explicit owner or role allowlist', async () => {
    repo.getBuyerEventAccess.mockResolvedValue({ creatorDid: 'did:imajin:other', podId: 'pod_1' });
    isPodMemberMock.mockResolvedValue(true);

    expect(await getBuyerTickets(EVENT_ID, OWNER_DID, 'session=caller')).toMatchObject({ hasAccess: true, isOrganizer: true });
    expect(isPodMemberMock).toHaveBeenCalledWith('pod_1', OWNER_DID, ['owner', 'host', 'cohost'], 'session=caller');
  });

  it('denies organizer access when app membership is absent or fails closed, even with a cookie', async () => {
    repo.getBuyerEventAccess.mockResolvedValue({ creatorDid: 'did:imajin:other', podId: 'pod_1' });
    isPodMemberMock.mockResolvedValue(false);

    expect(await getBuyerTickets(EVENT_ID, OWNER_DID, 'session=creator')).toMatchObject({
      hasTicket: false, hasAccess: false, isOrganizer: false, orders: [],
    });
    expect(isPodMemberMock).toHaveBeenCalledWith('pod_1', OWNER_DID, ['owner', 'host', 'cohost'], 'session=creator');
  });

  it('preserves ticket access without granting organizer access after a membership denial', async () => {
    arrange([buyerRow()]);
    repo.getBuyerEventAccess.mockResolvedValue({ creatorDid: 'did:imajin:other', podId: 'pod_1' });
    isPodMemberMock.mockResolvedValue(false);

    expect(await read()).toMatchObject({ hasTicket: true, hasAccess: true, isOrganizer: false });
  });

  it('propagates database failures to the thin route', async () => {
    repo.listOwnedTicketRows.mockRejectedValue(new Error('database down'));
    await expect(read()).rejects.toThrow('database down');
    repo.listOwnedTicketRows.mockResolvedValue([]);
    repo.getBuyerEventAccess.mockRejectedValue(new Error('event database down'));
    await expect(read()).rejects.toThrow('event database down');
  });
});
