/**
 * GET /api/events/[id]/my-ticket and GET /api/tickets/[id]/qr — the holder-side
 * access checks. Shared mocks live in support/ticket-access-support.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  OWNER_DID,
  QR_DATA_URI,
  SESSION_COOKIE,
  TICKET_ID,
  accessRequest,
  generateQRCodeMock,
  idParams,
  resetTicketAccessMocks,
} from './support/ticket-access-support';
import { nextSelect, selectMock, whereParams } from './support/db-queue-support';
import { isPodMemberMock } from './support/kernel-mock-support';
import { authFailure, mockLog, requireAuthMock } from './support/route-test-support';
import { GET as getMyTicket } from '../../app/api/events/[id]/my-ticket/route';
import { GET as getQr } from '../../app/api/tickets/[id]/qr/route';
import { buyerRow, PURCHASED_AT } from './support/buyer-tickets-support';

const OTHER_DID = 'did:imajin:someone-else';
const POD_ID = 'pod_1';
const NO_ACCESS = { hasTicket: false, hasAccess: false };

const myTicket = (cookie: string | undefined = SESSION_COOKIE) =>
  getMyTicket(accessRequest(`/api/events/${EVENT_ID}/my-ticket`, { cookie }), idParams(EVENT_ID));

const heldTicket = buyerRow({ orderId: null }, { registrationFormId: null }, null);

beforeEach(() => {
  resetTicketAccessMocks();
  vi.stubEnv('DYKIL_URL', '');
  requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID, scopes: [], via: 'token' } });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/events/[id]/my-ticket', () => {
  it('answers "no access" (200, not 401) when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await myTicket();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NO_ACCESS);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("lists the holder's tickets with a trimmed ticket-type summary", async () => {
    nextSelect([heldTicket]);
    nextSelect([{ creatorDid: OTHER_DID, podId: null }]);

    const res = await myTicket();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      hasTicket: true,
      hasAccess: true,
      isOrganizer: false,
      tickets: [
        {
          id: TICKET_ID,
          status: 'valid',
          purchasedAt: '2030-01-01T00:00:00.000Z',
          pricePaid: 2500,
          currency: 'CAD',
          ticketType: { name: 'VIP', description: 'Front row', perks: ['drink'] },
        },
      ],
      ticketId: TICKET_ID,
    });
    expect(body.orders).toEqual([{
      id: TICKET_ID, isLegacy: true, quantity: 1, totalAmount: 2500, currency: 'CAD',
      purchasedAt: PURCHASED_AT, ticketTypeName: 'VIP', fairSettlement: null,
      tickets: [{
        id: TICKET_ID, status: 'valid', usedAt: null, registrationStatus: 'pending', pricePaid: 2500, currency: 'CAD',
        ticketType: { name: 'VIP', description: 'Front row', perks: ['drink'], registrationFormId: null },
      }],
    }]);
    expect(body.registrationEmbedBaseUrl).toBeNull();
    expect(whereParams(0)).toEqual([EVENT_ID, OWNER_DID]);
    expect(whereParams(1)).toEqual([EVENT_ID]);
    expect(isPodMemberMock).not.toHaveBeenCalled();
  });

  it('reports a null ticketType when the ticket type row is gone', async () => {
    nextSelect([{ ticket: heldTicket.ticket, ticketType: null }]);
    nextSelect([]);

    const body = await (await myTicket()).json();

    expect(body.tickets[0].ticketType).toBeNull();
    expect(body.hasAccess).toBe(true);
  });
  it('exposes only a public registration base to authenticated callers', async () => {
    vi.stubEnv('DYKIL_URL', 'https://dykil.test/forms/?token=discard#discard');
    nextSelect([]);
    nextSelect([]);
    expect(await (await myTicket()).json()).toMatchObject({
      orders: [], registrationEmbedBaseUrl: 'https://dykil.test/forms',
    });
    requireAuthMock.mockResolvedValue(authFailure());
    expect(await (await myTicket()).json()).toEqual(NO_ACCESS);
  });

  it('grants access to the event creator without any ticket', async () => {
    nextSelect([]);
    nextSelect([{ creatorDid: OWNER_DID, podId: POD_ID }]);

    const body = await (await myTicket()).json();

    expect(body).toEqual({
      hasTicket: false, hasAccess: true, isOrganizer: true, tickets: [], ticketId: null,
      orders: [], registrationEmbedBaseUrl: null,
    });
    expect(isPodMemberMock).not.toHaveBeenCalled();
  });

  it('grants access to pod hosts / co-hosts, forwarding the caller cookie', async () => {
    nextSelect([]);
    nextSelect([{ creatorDid: OTHER_DID, podId: POD_ID }]);
    isPodMemberMock.mockResolvedValue(true);

    const body = await (await myTicket()).json();

    expect(body).toMatchObject({ hasTicket: false, hasAccess: true, isOrganizer: true });
    expect(isPodMemberMock).toHaveBeenCalledWith(POD_ID, OWNER_DID, ['owner', 'host', 'cohost'], SESSION_COOKIE);
  });

  it('passes a null cookie to the pod check for an app-token caller', async () => {
    nextSelect([]);
    nextSelect([{ creatorDid: OTHER_DID, podId: POD_ID }]);

    await myTicket('');

    expect(isPodMemberMock).toHaveBeenCalledWith(POD_ID, OWNER_DID, expect.any(Array), null);
  });

  it('denies a caller who is neither a ticket holder nor a pod member', async () => {
    nextSelect([]);
    nextSelect([{ creatorDid: OTHER_DID, podId: POD_ID }]);

    const body = await (await myTicket()).json();

    expect(body).toMatchObject({ ...NO_ACCESS, isOrganizer: false, ticketId: null });
  });

  it.each([
    ['the event has no pod', [{ creatorDid: OTHER_DID, podId: null }]],
    ['the event does not exist', []],
  ])('denies a non-holder when %s, without a pod lookup', async (_label, eventRows) => {
    nextSelect([]);
    nextSelect(eventRows);

    const body = await (await myTicket()).json();

    expect(body).toMatchObject({ ...NO_ACCESS, isOrganizer: false });
    expect(isPodMemberMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the database fails', () => nextSelect(new Error('boom'))],
    [
      'the pod lookup fails',
      () => {
        nextSelect([]);
        nextSelect([{ creatorDid: OTHER_DID, podId: POD_ID }]);
        isPodMemberMock.mockRejectedValue(new Error('boom'));
      },
    ],
  ])('returns a genuine server error when %s', async (_label, arrange) => {
    arrange();

    const res = await myTicket();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to check event access' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'Failed to check event access');
  });
});

describe('GET /api/tickets/[id]/qr', () => {
  const qr = () => getQr(accessRequest(`/api/tickets/${TICKET_ID}/qr`), idParams(TICKET_ID));
  const ERR_QR_FAILED = { error: 'Failed to generate QR code' };
  it('requires authentication before looking up the ticket', async () => {
    requireAuthMock.mockResolvedValue(authFailure());
    expect((await qr()).status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
    expect(generateQRCodeMock).not.toHaveBeenCalled();
  });

  it('returns 404 to a non-holder or for an unknown ticket', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OTHER_DID, scopes: [], via: 'token' } });
    expect((await qr()).status).toBe(404);
    expect(whereParams(0)).toEqual([TICKET_ID, OTHER_DID]);
    expect(generateQRCodeMock).not.toHaveBeenCalled();
  });

  it('uses the verified act-as holder rather than the caller DID', async () => {
    nextSelect([{ id: TICKET_ID }]);
    requireAuthMock.mockResolvedValue({
      identity: { id: OTHER_DID, actingAs: OWNER_DID, scopes: [], via: 'token' },
    });
    expect((await qr()).status).toBe(200);
    expect(whereParams(0)).toEqual([TICKET_ID, OWNER_DID]);
  });

  it('returns the holder QR code data URI without caching', async () => {
    nextSelect([{ id: TICKET_ID }]);
    const res = await qr();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrCodeDataUri: QR_DATA_URI });
    expect(generateQRCodeMock).toHaveBeenCalledWith(TICKET_ID);
    expect(whereParams(0)).toEqual([TICKET_ID, OWNER_DID]);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('answers 500 when the generator yields nothing', async () => {
    nextSelect([{ id: TICKET_ID }]);
    generateQRCodeMock.mockResolvedValue('');

    const res = await qr();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(ERR_QR_FAILED);
  });

  it('answers 500 and logs when the generator throws', async () => {
    nextSelect([{ id: TICKET_ID }]);
    generateQRCodeMock.mockRejectedValue(new Error('boom'));

    const res = await qr();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(ERR_QR_FAILED);
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'QR generation error');
  });
});
