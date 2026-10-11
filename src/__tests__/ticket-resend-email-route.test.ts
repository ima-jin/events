/**
 * Tests for app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts
 *
 * Email resolution (#1998): survey-response email wins; otherwise the kernel
 * client's `getContactEmail` (the profile service's batched resolve route) is
 * asked for the ticket owner's DID. No raw SQL is involved in this route.
 *
 * Also covers the 3-day resend cooldown, the registration-reminder vs
 * ticket-confirmed notification split, and the non-fatal failure paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BUYER_DID,
  ERR_EVENT_NOT_FOUND,
  ERR_TICKET_NOT_FOUND,
  EVENT_ID,
  ORGANIZER_DID,
  ROUTE_PARAMS,
  TICKET_ID,
  generateQRCodeMock,
  getContactEmailMock,
  getSurveyResponseForTicketMock,
  logMock,
  makeTicketRequest,
  nextSelect,
  publishMock,
  resetTicketRouteMocks,
  selectMock,
  setMock,
  updateMock,
  itReturns401WhenAuthFails,
  itReturns403WhenNotOrganizer,
} from './support/ticket-route-support';
import { tickets } from '@/db';
import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/resend-email/route';

const HOUR_MS = 60 * 60 * 1000;
const EVENT_TITLE = 'Test Event';
const SURVEY_EMAIL = 'survey@example.com';
const RESOLVED_EMAIL = 'resolved@example.com';

const BASE_TICKET = {
  id: TICKET_ID,
  eventId: EVENT_ID,
  ticketTypeId: 'tkt_type_1',
  ownerDid: BUYER_DID,
  registrationStatus: 'complete',
  lastEmailSentAt: null as Date | null,
  pricePaid: 5000,
  currency: 'CAD',
};

const BASE_EVENT = {
  id: EVENT_ID,
  title: EVENT_TITLE,
  startsAt: '2026-07-14T12:00:00.000Z',
  imageUrl: null as string | null,
  isVirtual: false,
  venue: null,
};

const BASE_TICKET_TYPE = { id: 'tkt_type_1', name: 'General Admission' };

const callResend = () => POST(makeTicketRequest('resend-email'), ROUTE_PARAMS);

/** Queue the three sequential selects: ticket, event, ticket type. */
function queueLookups(
  ticket: Record<string, unknown> = BASE_TICKET,
  event: Record<string, unknown> = BASE_EVENT
): void {
  nextSelect([ticket]);
  nextSelect([event]);
  nextSelect([BASE_TICKET_TYPE]);
}

/** Payload of the single published notification. */
function publishedPayload(): Record<string, unknown> {
  return (publishMock.mock.calls[0][1] as { payload: Record<string, unknown> }).payload;
}

describe('POST .../resend-email — email resolution (#1998)', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callResend);

  itReturns403WhenNotOrganizer(callResend);

  it('prefers the survey response email and never asks the kernel for a contact email', async () => {
    queueLookups();
    getSurveyResponseForTicketMock.mockResolvedValue({ answers: { email: SURVEY_EMAIL } });

    const res = await callResend();

    expect(res.status).toBe(200);
    expect(getSurveyResponseForTicketMock).toHaveBeenCalledWith(TICKET_ID);
    expect(getContactEmailMock).not.toHaveBeenCalled();
    expect(publishedPayload().email).toBe(SURVEY_EMAIL);
  });

  it('falls back to the kernel contact email when there is no survey response email', async () => {
    queueLookups();
    getContactEmailMock.mockResolvedValue(RESOLVED_EMAIL);

    const res = await callResend();

    expect(res.status).toBe(200);
    expect(getContactEmailMock).toHaveBeenCalledWith(BUYER_DID);
    expect(publishedPayload().email).toBe(RESOLVED_EMAIL);
  });

  it('returns 422 when neither the survey nor the kernel produce an email', async () => {
    queueLookups();

    const res = await callResend();

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Could not determine email/);
    expect(publishMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 422 without a kernel lookup when the ticket has no owner and no survey email', async () => {
    queueLookups({ ...BASE_TICKET, ownerDid: null });

    const res = await callResend();

    expect(res.status).toBe(422);
    expect(getContactEmailMock).not.toHaveBeenCalled();
  });
});

describe('POST .../resend-email — lookups and cooldown', () => {
  beforeEach(resetTicketRouteMocks);

  it('returns 404 when the ticket is not found', async () => {
    nextSelect([]);

    const res = await callResend();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_TICKET_NOT_FOUND });
  });

  it('returns 404 when the event is not found', async () => {
    nextSelect([BASE_TICKET]);
    nextSelect([]);

    const res = await callResend();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_EVENT_NOT_FOUND });
  });

  it('returns 404 when the ticket type is not found', async () => {
    nextSelect([BASE_TICKET]);
    nextSelect([BASE_EVENT]);
    nextSelect([]);

    const res = await callResend();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Ticket type not found' });
  });

  it('returns 429 with the time remaining when an email was sent within 3 days', async () => {
    const lastEmailSentAt = new Date(Date.now() - HOUR_MS);
    nextSelect([{ ...BASE_TICKET, lastEmailSentAt }]);

    const res = await callResend();

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('Email was recently sent. Try again in ~71h.');
    expect(body.lastEmailSentAt).toBe(lastEmailSentAt.toISOString());
    expect(selectMock).toHaveBeenCalledOnce(); // event / type never loaded
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('allows a resend once the 3-day cooldown has elapsed', async () => {
    queueLookups({ ...BASE_TICKET, lastEmailSentAt: new Date(Date.now() - 73 * HOUR_MS) });
    getContactEmailMock.mockResolvedValue(RESOLVED_EMAIL);

    const res = await callResend();

    expect(res.status).toBe(200);
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callResend();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to resend email' });
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('POST .../resend-email — notification', () => {
  beforeEach(() => {
    resetTicketRouteMocks();
    getContactEmailMock.mockResolvedValue(RESOLVED_EMAIL);
  });

  it('publishes ticket.confirmed with a QR code for a completed registration', async () => {
    queueLookups();

    const res = await callResend();

    expect(res.status).toBe(200);
    expect(generateQRCodeMock).toHaveBeenCalledWith(TICKET_ID);
    expect(publishMock).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledWith(
      'ticket.confirmed',
      expect.objectContaining({ issuer: ORGANIZER_DID, subject: BUYER_DID, scope: 'events' })
    );
    expect(publishedPayload()).toMatchObject({
      email: RESOLVED_EMAIL,
      eventTitle: EVENT_TITLE,
      ticketType: 'General Admission',
      ticketId: TICKET_ID,
      isVirtual: false,
      magicLink: 'https://events.test/e/evt_1/my-tickets',
      eventUrl: 'https://events.test/e/evt_1',
      qrCodeDataUri: 'data:image/png;base64,stub',
      context_id: EVENT_ID,
      context_type: 'event',
    });
    expect(String(publishedPayload().eventDate)).toMatch(/2026/);
    expect(String(publishedPayload().price)).toMatch(/50\.00/);
  });

  it('labels a ticket with no price as Free', async () => {
    queueLookups({ ...BASE_TICKET, pricePaid: null });

    await callResend();

    expect(publishedPayload().price).toBe('Free');
  });

  it('publishes a registration reminder (no QR code) while registration is pending', async () => {
    queueLookups({ ...BASE_TICKET, registrationStatus: 'pending' });

    const res = await callResend();

    expect(res.status).toBe(200);
    expect(generateQRCodeMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'ticket.registration.reminder',
      expect.objectContaining({ issuer: ORGANIZER_DID, subject: BUYER_DID })
    );
    expect(publishedPayload()).toMatchObject({
      email: RESOLVED_EMAIL,
      eventTitle: EVENT_TITLE,
      pendingCount: 1,
      registrationUrl: 'https://events.test/e/evt_1/register',
    });
  });

  it.each([
    ['/media/cover.png', 'https://events.test/media/cover.png'],
    ['https://cdn.test/cover.png', 'https://cdn.test/cover.png'],
    [null, undefined],
  ])('resolves the event image %s to %s', async (imageUrl, expected) => {
    queueLookups(BASE_TICKET, { ...BASE_EVENT, imageUrl });

    await callResend();

    expect(publishedPayload().eventImageUrl).toBe(expected);
  });

  it('records the send time and returns the redacted address', async () => {
    queueLookups();

    const res = await callResend();

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      email: 'r***d@example.com',
      lastEmailSentAt: expect.any(String),
    });
    expect(updateMock).toHaveBeenCalledWith(tickets);
    expect(setMock).toHaveBeenCalledWith({ lastEmailSentAt: new Date(body.lastEmailSentAt) });
  });

  it.each([
    ['ab@example.com', '***@example.com'],
    ['not-an-email', '***'],
  ])('redacts short or malformed address %s as %s', async (address, expected) => {
    queueLookups();
    getContactEmailMock.mockResolvedValue(address);

    const res = await callResend();

    expect((await res.json()).email).toBe(expected);
  });

  it.each(['complete', 'pending'])('does not fail the resend when publishing rejects (%s registration)', async (registrationStatus) => {
    queueLookups({ ...BASE_TICKET, registrationStatus });
    publishMock.mockRejectedValue(new Error('bus down'));

    const res = await callResend();

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(logMock.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, expect.any(String)));
  });
});
