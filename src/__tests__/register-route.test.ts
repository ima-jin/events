/**
 * POST / GET /api/register/[ticketId] — per-ticket registration: verify the
 * attendee's dykil survey response, flip the ticket to `complete` and emit the
 * notification events. Shared mocks live in support/ticket-access-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_ID,
  OWNER_DID,
  QR_DATA_URI,
  TICKET_ID,
  accessRequest,
  generateQRCodeMock,
  getSurveyResponseForTicketMock,
  makeTicket,
  publishMock,
  resetTicketAccessMocks,
} from './support/ticket-access-support';
import { nextSelect, nextUpdate, selectMock, setValues, updateMock, updatedTables, whereParams } from './support/db-queue-support';
import { mockLog } from './support/route-test-support';
import { tickets } from '@/db';
import { GET, POST } from '../../app/api/register/[ticketId]/route';

const REGISTER_PATH = `/api/register/${TICKET_ID}`;
const ERR_NO_RESPONSE = 'No survey response found for this ticket';
const ERR_COMPLETION_FAILED = 'failed to publish registration completion events';
const ATTENDEE_EMAIL = 'buyer@example.com';

const surveyResponse = (answers: unknown = { email: ` ${ATTENDEE_EMAIL.toUpperCase()} `, full_name: 'Buyer' }) => ({
  id: 'resp_1',
  surveyId: 'form_1',
  answers,
});

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  title: 'Launch Party',
  startsAt: new Date('2030-06-15T18:30:00.000Z'),
  isVirtual: false,
  venue: 'Town Hall',
  imageUrl: '/images/launch.png',
  ...overrides,
});

const ticketTypeRow = { id: 'tt_1', name: 'VIP' };

const register = () => POST(accessRequest(REGISTER_PATH, { method: 'POST' }));
const lookup = () => GET(accessRequest(REGISTER_PATH));

interface Scenario {
  ticket?: Record<string, unknown>;
  event?: Record<string, unknown> | null;
  ticketType?: Record<string, unknown> | null;
  survey?: unknown;
}

/** Queue a pending ticket whose survey response exists, plus the event / ticket type the notifier loads. */
function arrange({ ticket = {}, event = {}, ticketType = ticketTypeRow, survey = surveyResponse() }: Scenario = {}): void {
  nextSelect([makeTicket(ticket)]);
  getSurveyResponseForTicketMock.mockResolvedValue(survey);
  nextSelect(event === null ? [] : [eventRow(event)]);
  nextSelect(ticketType === null ? [] : [ticketType]);
}

const publishedTypes = () => publishMock.mock.calls.map(([type]) => type as string);
const completedPayload = () => {
  const call = publishMock.mock.calls.find(([type]) => type === 'ticket.registration.completed');
  return (call?.[1] as { payload: Record<string, unknown> }).payload;
};

beforeEach(() => {
  resetTicketAccessMocks();
});

describe('POST /api/register/[ticketId]', () => {
  it('answers 404 when the ticket does not exist', async () => {
    nextSelect([]);

    const res = await register();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Ticket not found' });
    expect(mockLog.warn).toHaveBeenCalledWith({ ticketId: TICKET_ID }, 'ticket not found');
    expect(getSurveyResponseForTicketMock).not.toHaveBeenCalled();
  });

  it.each(['complete', 'not_required'])('answers 409 (idempotent) when registration is already %s', async (registrationStatus) => {
    nextSelect([makeTicket({ registrationStatus })]);

    const res = await register();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `Ticket registration status is '${registrationStatus}', expected 'pending'`,
    });
    expect(getSurveyResponseForTicketMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the attendee has not submitted the survey', async () => {
    nextSelect([makeTicket()]);

    const res = await register();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_NO_RESPONSE });
    expect(getSurveyResponseForTicketMock).toHaveBeenCalledWith(TICKET_ID);
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('completes the registration and publishes the three notification events', async () => {
    arrange();

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, qrCodeDataUri: QR_DATA_URI });
    expect(whereParams(0)).toEqual([TICKET_ID]);
    expect(updatedTables()).toEqual([tickets]);
    expect(setValues()).toEqual([{ registrationStatus: 'complete' }]);
    expect(generateQRCodeMock).toHaveBeenCalledWith(TICKET_ID);
    expect(publishedTypes()).toEqual(['event.registration', 'event.rsvp', 'ticket.registration.completed']);

    expect(publishMock).toHaveBeenCalledWith('event.registration', {
      issuer: OWNER_DID,
      subject: OWNER_DID,
      scope: 'events',
      payload: { eventTitle: 'Launch Party', email: ATTENDEE_EMAIL, context_id: EVENT_ID, context_type: 'event' },
    });
    expect(publishMock).toHaveBeenCalledWith('event.rsvp', {
      issuer: OWNER_DID,
      subject: '',
      scope: 'events',
      payload: { context_id: EVENT_ID, context_type: 'event', interestDids: [OWNER_DID] },
    });
    expect(completedPayload()).toEqual({
      email: ATTENDEE_EMAIL,
      eventTitle: 'Launch Party',
      ticketType: 'VIP',
      ticketId: TICKET_ID,
      eventDate: expect.stringMatching(/^\w+day, June 1[56], 2030$/),
      eventTime: expect.stringMatching(/\d{1,2}:\d{2}\s?[AP]M/),
      isVirtual: false,
      venue: 'Town Hall',
      price: 'CA$25.00',
      magicLink: `https://events.test/e/${EVENT_ID}`,
      eventImageUrl: 'https://events.test/images/launch.png',
      eventUrl: `https://events.test/e/${EVENT_ID}`,
      qrCodeDataUri: QR_DATA_URI,
      context_id: EVENT_ID,
      context_type: 'event',
    });
  });

  it.each([
    ['keeps an absolute image URL', { imageUrl: 'https://cdn.test/launch.png' }, 'https://cdn.test/launch.png'],
    ['omits a missing image', { imageUrl: null }, undefined],
  ])('%s', async (_label, event, expected) => {
    arrange({ event });

    await register();

    expect(completedPayload().eventImageUrl).toBe(expected);
  });

  it.each([
    ['labels a free ticket "Included"', { pricePaid: null }, 'Included'],
    ['formats the price in USD when the ticket has no currency', { currency: null }, '$25.00'],
    ['formats the price in the ticket currency', { currency: 'EUR', pricePaid: 1999 }, '€19.99'],
  ])('%s', async (_label, ticket, price) => {
    arrange({ ticket });

    await register();

    expect(completedPayload().price).toBe(price);
  });

  it('defaults the optional event / ticket-type fields', async () => {
    arrange({ event: { isVirtual: null, venue: null }, ticketType: null });

    await register();

    expect(completedPayload()).toMatchObject({ ticketType: 'Ticket', isVirtual: false, venue: undefined });
  });

  it('skips the RSVP signal for an unowned ticket', async () => {
    arrange({ ticket: { ownerDid: null } });

    await register();

    expect(publishedTypes()).toEqual(['event.registration', 'ticket.registration.completed']);
    expect(publishMock).toHaveBeenCalledWith('event.registration', expect.objectContaining({ issuer: '', subject: '' }));
  });

  it.each([
    ['answers have no email', {}],
    ['answers have a non-string email', { email: 42 }],
    ['answers are missing', null],
  ])('completes without notifications when the survey %s', async (_label, answers) => {
    arrange({ survey: surveyResponse(answers) });

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(setValues()).toEqual([{ registrationStatus: 'complete' }]);
    expect(publishMock).not.toHaveBeenCalled();
    expect(generateQRCodeMock).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      { ticketId: TICKET_ID },
      'no attendee email in survey answers; skipping registration emails',
    );
  });

  it('completes without notifications when the event no longer exists', async () => {
    arrange({ event: null });

    const res = await register();

    expect(await res.json()).toEqual({ success: true });
    expect(publishMock).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no attendee email'));
  });

  it('keeps the registration when QR generation fails (notifications are non-fatal)', async () => {
    arrange();
    generateQRCodeMock.mockRejectedValue(new Error('boom'));

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(publishMock).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, ERR_COMPLETION_FAILED);
  });

  it('keeps the registration when the notification lookups fail', async () => {
    nextSelect([makeTicket()]);
    getSurveyResponseForTicketMock.mockResolvedValue(surveyResponse());
    nextSelect(new Error('boom'));

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, ERR_COMPLETION_FAILED);
  });

  it('logs, but still succeeds, when each fire-and-forget publish rejects', async () => {
    arrange();
    publishMock.mockRejectedValue(new Error('bus down'));

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, qrCodeDataUri: QR_DATA_URI });
    await expect
      .poll(() => mockLog.error.mock.calls.map(([, message]) => message))
      .toEqual([
        'event.registration publish failed',
        'event.rsvp publish failed',
        'ticket.registration.completed publish failed',
      ]);
  });

  it('propagates a failure to flip the ticket status (nothing is published)', async () => {
    arrange();
    nextUpdate(new Error('boom'));

    await expect(register()).rejects.toThrow('boom');
    expect(publishMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/register/[ticketId]', () => {
  it('answers 404 when the ticket has no survey response', async () => {
    const res = await lookup();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Registration not found' });
    expect(getSurveyResponseForTicketMock).toHaveBeenCalledWith(TICKET_ID);
  });

  it('returns the backwards-compatible registration shape', async () => {
    getSurveyResponseForTicketMock.mockResolvedValue(surveyResponse({ email: ATTENDEE_EMAIL, full_name: 'Buyer', name: 'ignored' }));

    const res = await lookup();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      registration: {
        id: 'resp_1',
        ticketId: TICKET_ID,
        formId: 'form_1',
        responseId: 'resp_1',
        name: 'Buyer',
        email: ATTENDEE_EMAIL,
      },
    });
  });

  it.each([
    ['falls back to the "name" answer', { name: 'Nick' }, 'Nick'],
    ['reports a null name when none was answered', {}, null],
  ])('%s', async (_label, answers, name) => {
    getSurveyResponseForTicketMock.mockResolvedValue(surveyResponse(answers));

    const { registration } = await (await lookup()).json();

    expect(registration).toMatchObject({ name, email: null });
  });

  it('tolerates a response without answers', async () => {
    getSurveyResponseForTicketMock.mockResolvedValue({ id: 'resp_1', surveyId: 'form_1', answers: undefined });

    const { registration } = await (await lookup()).json();

    expect(registration).toMatchObject({ name: null, email: null });
  });
});
