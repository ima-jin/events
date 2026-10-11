/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/check-in/route.ts
 *
 * Cases:
 *  - Success: valid ticket stamped used_at, checkin.create + event.attendance published
 *  - Already checked in (used_at set) → 400
 *  - Ticket not in 'valid' status → 400
 *  - Ticket not found → 404
 *  - Non-organizer → 403
 *  - Unauthenticated → 401
 *
 * Hard-eligibility (tier upgrade) is not re-derived in this app — the route
 * just calls the kernel client's evaluateEligibility(), which owns the rule,
 * the CAS upgrade and the attestation emission. The optional
 * CHECKIN_WEBHOOK_URL side effect is fire-and-forget and covered separately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ERR_TICKET_NOT_FOUND,
  EVENT_ID,
  ORGANIZER_DID,
  ROUTE_PARAMS,
  TICKET_ID,
  evaluateEligibilityMock,
  fetchMock,
  logMock,
  makeTicketRequest,
  nextSql,
  publishMock,
  resetTicketRouteMocks,
  sqlMock,
  sqlStatement,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
} from './support/ticket-route-support';
import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/check-in/route';

const ATTENDEE_DID = 'did:imajin:attendee';
const USED_AT = '2026-07-14T14:00:00.000Z';
const CHECKIN_CREATE = 'checkin.create';
const WEBHOOK_URL = 'https://hooks.test/checkin';

const VALID_TICKET = { id: TICKET_ID, status: 'valid', used_at: null, owner_did: ATTENDEE_DID };
const USED_ROW = { id: TICKET_ID, used_at: USED_AT, status: 'used' };

const callCheckIn = () => POST(makeTicketRequest('check-in'), ROUTE_PARAMS);

/** Queue a successful check-in (ticket SELECT, then UPDATE ... RETURNING). */
function queueCheckIn(ticket: Record<string, unknown> = VALID_TICKET): void {
  nextSql([ticket]);
  nextSql([USED_ROW]);
}

describe('POST /api/events/[id]/tickets/[ticketId]/check-in', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callCheckIn);

  itReturns403WhenNotOrganizer(callCheckIn);

  it('returns 404 when ticket is not found', async () => {
    nextSql([]); // ticket SELECT → empty

    const res = await callCheckIn();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: ERR_TICKET_NOT_FOUND });
  });

  it('returns 400 when ticket status is not valid', async () => {
    nextSql([{ ...VALID_TICKET, status: 'held' }]);

    const res = await callCheckIn();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket is not valid' });
    expect(sqlMock).toHaveBeenCalledOnce(); // no UPDATE issued
  });

  it('returns 400 when ticket is already checked in', async () => {
    nextSql([{ ...VALID_TICKET, used_at: USED_AT }]);

    const res = await callCheckIn();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Ticket already checked in' });
    expect(sqlMock).toHaveBeenCalledOnce();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('stamps used_at, publishes checkin.create and event.attendance on success', async () => {
    queueCheckIn();

    const res = await callCheckIn();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: { id: TICKET_ID, usedAt: USED_AT } });
    expect(sqlStatement(1)).toContain("UPDATE events.tickets SET used_at = NOW(), status = 'used'");

    const publishedTypes = publishMock.mock.calls.map(([type]) => type);
    expect(publishedTypes).toEqual([CHECKIN_CREATE, 'event.attendance']);

    expect(publishMock).toHaveBeenCalledWith(
      CHECKIN_CREATE,
      expect.objectContaining({
        issuer: ORGANIZER_DID,
        scope: 'events',
        payload: { eventId: EVENT_ID, ticketId: TICKET_ID, attendeeDid: ATTENDEE_DID },
      })
    );
    // event.attendance carries the attendee DID as subject
    expect(publishMock).toHaveBeenCalledWith(
      'event.attendance',
      expect.objectContaining({
        issuer: ORGANIZER_DID,
        subject: ATTENDEE_DID,
        payload: expect.objectContaining({ ticketId: TICKET_ID, usedAt: USED_AT, checkedInBy: ORGANIZER_DID }),
      })
    );

    // Hard-eligibility is delegated to the kernel — no local SQL, no local publish.
    expect(evaluateEligibilityMock).toHaveBeenCalledWith(ATTENDEE_DID);
  });

  it('does not call evaluateEligibility or publish event.attendance when the ticket has no owner_did', async () => {
    queueCheckIn({ ...VALID_TICKET, owner_did: null });

    const res = await callCheckIn();

    expect(res.status).toBe(200);
    expect(evaluateEligibilityMock).not.toHaveBeenCalled();
    expect(publishMock.mock.calls.map(([type]) => type)).toEqual([CHECKIN_CREATE]);
  });

  it('does not fail check-in when evaluateEligibility rejects', async () => {
    queueCheckIn();
    evaluateEligibilityMock.mockRejectedValue(new Error('kernel unreachable'));

    const res = await callCheckIn();

    expect(res.status).toBe(200);
    await expectLogged();
  });

  it('does not fail check-in when publishing a domain event rejects', async () => {
    queueCheckIn();
    publishMock.mockRejectedValue(new Error('bus down'));

    const res = await callCheckIn();

    expect(res.status).toBe(200);
    await expectLogged();
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    sqlMock.mockRejectedValueOnce(new Error('db down'));

    const res = await callCheckIn();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to check in ticket' });
  });

  describe('CHECKIN_WEBHOOK_URL (fire-and-forget)', () => {
    it('does not call a webhook when unset', async () => {
      queueCheckIn();

      await callCheckIn();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the check-in with the attendee count and event title', async () => {
      process.env.CHECKIN_WEBHOOK_URL = WEBHOOK_URL;
      queueCheckIn();
      nextSql([{ count: '7' }]); // attendee count
      nextSql([{ title: 'Test Event' }]); // event title

      try {
        const res = await callCheckIn();
        expect(res.status).toBe(200);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(WEBHOOK_URL);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
          event: 'checkin',
          eventId: EVENT_ID,
          eventTitle: 'Test Event',
          ticketId: TICKET_ID,
          ownerDid: ATTENDEE_DID,
          checkedInAt: USED_AT,
          attendeeCount: 7,
        });
      } finally {
        delete process.env.CHECKIN_WEBHOOK_URL;
      }
    });

    it('does not fail check-in when the webhook call fails', async () => {
      process.env.CHECKIN_WEBHOOK_URL = WEBHOOK_URL;
      queueCheckIn();
      fetchMock.mockRejectedValue(new Error('webhook down'));

      try {
        const res = await callCheckIn();
        expect(res.status).toBe(200);
        await vi.waitFor(() =>
          expect(logMock.error).toHaveBeenCalledWith(expect.anything(), 'Check-in webhook error')
        );
      } finally {
        delete process.env.CHECKIN_WEBHOOK_URL;
      }
    });
  });
});

/** The fire-and-forget failure paths all end in a `log.error` call. */
async function expectLogged(): Promise<void> {
  await vi.waitFor(() => expect(logMock.error).toHaveBeenCalled());
}
