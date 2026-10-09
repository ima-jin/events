/**
 * Tests for apps/events/app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts
 *
 * #1998: this route used to run a raw `SELECT contact_email FROM
 * profile.profiles` query before falling back to `getEmailForDid`. It now
 * calls `resolveEmailForDid` (which itself calls the profile service's
 * batched `/api/resolve` route) directly, with no raw SQL for identity
 * resolution left in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextDrizzleSelect, resetRouteMocks, ticketRequest, TICKET_ROUTE_PARAMS } from './support/route-test-support';

const extra = vi.hoisted(() => ({
  resolveEmailForDidMock: vi.fn(),
  getSurveyResponseForTicketMock: vi.fn(),
  generateQRCodeMock: vi.fn().mockResolvedValue('data:image/png;base64,stub'),
}));

vi.mock('@/lib/kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kernel')>()),
  getContactEmail: extra.resolveEmailForDidMock,
}));

vi.mock('@/lib/ticket-survey', () => ({
  getSurveyResponseForTicket: extra.getSurveyResponseForTicketMock,
}));

vi.mock('@/lib/email', () => ({
  generateQRCode: extra.generateQRCodeMock,
}));

vi.mock('@ima-jin/config', () => ({
  eventUrl: () => 'https://events.test/e/evt_1',
  eventRegisterUrl: () => 'https://events.test/e/evt_1/register',
  eventMyTicketsUrl: () => 'https://events.test/e/evt_1/my-tickets',
  buildPublicUrlAbsolute: () => 'https://events.test',
}));

import { POST } from '../../app/api/events/[id]/tickets/[ticketId]/resend-email/route';

const makeRequest = () => ticketRequest('resend-email');

const BASE_TICKET = {
  id: 'tkt_1',
  eventId: 'evt_1',
  ticketTypeId: 'tkt_type_1',
  ownerDid: 'did:imajin:buyer',
  registrationStatus: 'complete',
  lastEmailSentAt: null,
  pricePaid: 5000,
  currency: 'CAD',
};

const BASE_EVENT = {
  id: 'evt_1',
  title: 'Test Event',
  startsAt: new Date().toISOString(),
  imageUrl: null,
  isVirtual: false,
  venue: null,
};

const BASE_TICKET_TYPE = { id: 'tkt_type_1', name: 'General Admission' };

beforeEach(() => {
  resetRouteMocks();
  extra.generateQRCodeMock.mockResolvedValue('data:image/png;base64,stub');
  extra.resolveEmailForDidMock.mockResolvedValue(null);
  extra.getSurveyResponseForTicketMock.mockResolvedValue(null); // default: no survey response
});

describe('POST .../resend-email — email resolution (#1998)', () => {
  it('prefers the survey response email and never calls resolveEmailForDid', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    extra.getSurveyResponseForTicketMock.mockResolvedValue({
      id: 'resp_1',
      surveyId: 'form_1',
      answers: { email: 'survey@example.com' },
    });

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(extra.resolveEmailForDidMock).not.toHaveBeenCalled();
  });

  it('falls back to resolveEmailForDid when there is no survey response email', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    extra.resolveEmailForDidMock.mockResolvedValue('resolved@example.com');

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(extra.resolveEmailForDidMock).toHaveBeenCalledWith('did:imajin:buyer');
  });

  it('returns 422 when neither the survey nor resolveEmailForDid produce an email', async () => {
    nextDrizzleSelect([BASE_TICKET]);
    nextDrizzleSelect([BASE_EVENT]);
    nextDrizzleSelect([BASE_TICKET_TYPE]);
    extra.resolveEmailForDidMock.mockResolvedValue(null);

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Could not determine email/);
  });

  it('returns 404 when the ticket is not found', async () => {
    nextDrizzleSelect([]);

    const res = await POST(makeRequest(), TICKET_ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });
});
