/**
 * GET /api/events/[id]/my-ticket and GET /api/tickets/[id]/qr — the holder-side
 * access checks. Shared mocks live in support/ticket-access-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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

const OTHER_DID = 'did:imajin:someone-else';
const POD_ID = 'pod_1';
const NO_ACCESS = { hasTicket: false, hasAccess: false };

const myTicket = (cookie: string | undefined = SESSION_COOKIE) =>
  getMyTicket(accessRequest(`/api/events/${EVENT_ID}/my-ticket`, { cookie }), idParams(EVENT_ID));

const heldTicket = {
  ticket: { id: TICKET_ID, status: 'valid', purchasedAt: '2030-01-01T00:00:00.000Z', pricePaid: 2500, currency: 'CAD', secret: 'x' },
  ticketType: { name: 'VIP', description: 'Front row', perks: ['drink'], price: 2500 },
};

beforeEach(() => {
  resetTicketAccessMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID, scopes: [], via: 'token' } });
});

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
    expect(await res.json()).toEqual({
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

  it('grants access to the event creator without any ticket', async () => {
    nextSelect([]);
    nextSelect([{ creatorDid: OWNER_DID, podId: POD_ID }]);

    const body = await (await myTicket()).json();

    expect(body).toEqual({ hasTicket: false, hasAccess: true, isOrganizer: true, tickets: [], ticketId: null });
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
  ])('degrades to "no access" with an empty ticket list when %s', async (_label, arrange) => {
    arrange();

    const res = await myTicket();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...NO_ACCESS, tickets: [] });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'Failed to check event access');
  });
});

describe('GET /api/tickets/[id]/qr', () => {
  const qr = () => getQr(accessRequest(`/api/tickets/${TICKET_ID}/qr`), idParams(TICKET_ID));
  const ERR_QR_FAILED = { error: 'Failed to generate QR code' };

  it('returns the QR code data URI for the ticket id', async () => {
    const res = await qr();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrCodeDataUri: QR_DATA_URI });
    expect(generateQRCodeMock).toHaveBeenCalledWith(TICKET_ID);
  });

  it('answers 500 when the generator yields nothing', async () => {
    generateQRCodeMock.mockResolvedValue('');

    const res = await qr();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(ERR_QR_FAILED);
  });

  it('answers 500 and logs when the generator throws', async () => {
    generateQRCodeMock.mockRejectedValue(new Error('boom'));

    const res = await qr();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(ERR_QR_FAILED);
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'QR generation error');
  });
});
