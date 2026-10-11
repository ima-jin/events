/**
 * Shared mocks + fixtures for the ticket-access route suites: migrate-tickets,
 * events/[id]/my-ticket, tickets/[id]/qr and register/[ticketId].
 *
 * On top of the common seams (`./route-test-support` logger / auth / config,
 * `./db-queue-support` db, `./kernel-mock-support` kernel + fetch) it mocks the
 * three app-local collaborators these routes call:
 *   - `@/lib/email`          generateQRCode
 *   - `@/lib/ticket-survey`  getSurveyResponseForTicket (dykil lookup)
 *   - `@/lib/domain-events`  publish
 *
 * Import this module BEFORE the route under test.
 */
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import { resetRouteTestMocks } from './route-test-support';
import { resetDbMocks } from './db-queue-support';
import { resetKernelMocks } from './kernel-mock-support';

const hoisted = vi.hoisted(() => ({
  generateQRCodeMock: vi.fn(),
  getSurveyResponseForTicketMock: vi.fn(),
  publishMock: vi.fn(),
}));

export const { generateQRCodeMock, getSurveyResponseForTicketMock, publishMock } = hoisted;

vi.mock('@/lib/email', () => ({ generateQRCode: hoisted.generateQRCodeMock }));
vi.mock('@/lib/ticket-survey', () => ({ getSurveyResponseForTicket: hoisted.getSurveyResponseForTicketMock }));
vi.mock('@/lib/domain-events', () => ({ publish: hoisted.publishMock }));

export const EVENT_ID = 'evt_1';
export const TICKET_ID = 'tkt_1';
export const OWNER_DID = 'did:imajin:holder';
export const QR_DATA_URI = 'data:image/png;base64,stub';
export const SESSION_COOKIE = 'session=abc';

/** A ticket row; override any column. */
export function makeTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TICKET_ID,
    eventId: EVENT_ID,
    ticketTypeId: 'tt_1',
    ownerDid: OWNER_DID,
    registrationStatus: 'pending',
    status: 'valid',
    pricePaid: 2500,
    currency: 'CAD',
    ...overrides,
  };
}

/** `NextRequest` for an events-app path (starts with `/`), JSON body and/or cookie optional. */
export function accessRequest(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): NextRequest {
  const { method = 'GET', body, cookie } = options;
  const hasBody = body !== undefined;
  return new NextRequest(`https://events.test${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

/** Next 15 route context: `params` is a promise. */
export function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** `beforeEach` reset for every ticket-access suite. */
export function resetTicketAccessMocks(): void {
  resetRouteTestMocks();
  resetDbMocks();
  resetKernelMocks();
  generateQRCodeMock.mockReset().mockResolvedValue(QR_DATA_URI);
  getSurveyResponseForTicketMock.mockReset().mockResolvedValue(null);
  publishMock.mockReset().mockResolvedValue({});
}
