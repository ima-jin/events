import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attendingRow,
  BUYER_DID,
  EVENT_ID,
  exportRow,
  ORGANIZER_DID,
  OWNER_DID,
  profile,
  profileMap,
  surveyMap,
  ticketRow,
} from '../support/guests-support';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  isEventOrganizer: vi.fn(),
  resolveProfiles: vi.fn(),
  listMemberPodIds: vi.fn(),
  getSurveyResponsesForTickets: vi.fn(),
  getSurveyForms: vi.fn(),
  repo: {
    getEventTitle: vi.fn(),
    listCreatedEvents: vi.fn(),
    listGuestExportRows: vi.fn(),
    listGuestTicketRows: vi.fn(),
    listHeldEventIds: vi.fn(),
    listPodEvents: vi.fn(),
    listTicketedEvents: vi.fn(),
  },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('@/services/authorization', () => ({ isEventOrganizer: mocks.isEventOrganizer }));
vi.mock('@/repositories/guests-repository', () => mocks.repo);
vi.mock('@/lib/kernel', () => ({
  resolveProfiles: mocks.resolveProfiles,
  listMemberPodIds: mocks.listMemberPodIds,
}));
vi.mock('@/lib/surveys', () => ({
  getSurveyResponsesForTickets: mocks.getSurveyResponsesForTickets,
  getSurveyForms: mocks.getSurveyForms,
}));

import { ServiceError } from '@/services/errors';
import {
  buildGuestCsv,
  getGuestSummary,
  listAttendingEvents,
  listEventGuests,
} from '@/services/guests-service';

const COOKIE = 'session=abc';
const OWNER_PROFILE = profile(OWNER_DID, 'Owner Name', 'owner-handle', 'owner@example.com');
const BUYER_PROFILE = profile(BUYER_DID, 'Buyer Name', 'buyer-handle', 'buyer@example.com');

async function thrown(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error('expected the call to throw');
}

function csvLines(content: string): string[] {
  return content.replace('\uFEFF', '').split('\r\n');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'creator' });
  mocks.resolveProfiles.mockResolvedValue(new Map());
  mocks.getSurveyResponsesForTickets.mockResolvedValue(new Map());
  mocks.getSurveyForms.mockResolvedValue(new Map());
  mocks.listMemberPodIds.mockResolvedValue([]);
  mocks.repo.getEventTitle.mockResolvedValue({ id: EVENT_ID, title: 'Test Event' });
  mocks.repo.listGuestTicketRows.mockResolvedValue([]);
  mocks.repo.listGuestExportRows.mockResolvedValue([]);
  mocks.repo.listTicketedEvents.mockResolvedValue([]);
  mocks.repo.listCreatedEvents.mockResolvedValue([]);
  mocks.repo.listPodEvents.mockResolvedValue([]);
  mocks.repo.listHeldEventIds.mockResolvedValue([]);
});

describe('listEventGuests', () => {
  it('rejects a non-organizer with the kernel 403 before touching any data', async () => {
    mocks.isEventOrganizer.mockResolvedValue({ authorized: false });

    const error = await thrown(listEventGuests(EVENT_ID, ORGANIZER_DID, COOKIE));

    expect(error).toMatchObject({ code: 'forbidden', status: 403, message: 'Forbidden' });
    expect(mocks.isEventOrganizer).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, COOKIE);
    expect(mocks.repo.listGuestTicketRows).not.toHaveBeenCalled();
    expect(mocks.resolveProfiles).not.toHaveBeenCalled();
  });

  it('resolves owner and buyer DIDs in one batched call and fills profile + resolved attendee', async () => {
    mocks.repo.listGuestTicketRows.mockResolvedValue([ticketRow({ registration_form_id: 'form_1' })]);
    mocks.resolveProfiles.mockResolvedValue(profileMap(OWNER_PROFILE, BUYER_PROFILE));

    const { guests, isOwner } = await listEventGuests(EVENT_ID, ORGANIZER_DID);

    expect(isOwner).toBe(true);
    expect(mocks.resolveProfiles).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProfiles).toHaveBeenCalledWith([OWNER_DID, BUYER_DID]);
    expect(mocks.getSurveyResponsesForTickets).toHaveBeenCalledWith([{ ticketId: 'tkt_1', formId: 'form_1' }]);
    expect(guests).toHaveLength(1);
    expect(guests[0]).toMatchObject({
      id: 'tkt_1',
      ownerDid: OWNER_DID,
      ticketType: 'General',
      paymentMethod: 'stripe',
      profile: { name: 'Owner Name', handle: 'owner-handle', avatar: null, email: 'owner@example.com' },
      resolvedName: 'Owner Name',
      resolvedEmail: 'owner@example.com',
      guestOf: 'Buyer Name',
      attendeeName: null,
      orderAmountTotal: 5000,
    });
  });

  it('prefers survey answers for the attendee name and email', async () => {
    mocks.repo.listGuestTicketRows.mockResolvedValue([ticketRow()]);
    mocks.getSurveyResponsesForTickets.mockResolvedValue(
      surveyMap({ tkt_1: { full_name: 'Survey Name', email: 'survey@example.com' } }),
    );
    mocks.resolveProfiles.mockResolvedValue(profileMap(OWNER_PROFILE));

    const { guests } = await listEventGuests(EVENT_ID, ORGANIZER_DID);

    expect(guests[0]).toMatchObject({
      attendeeName: 'Survey Name',
      resolvedName: 'Survey Name',
      resolvedEmail: 'survey@example.com',
    });
  });

  it('falls back to the survey "name" answer, and nulls missing optional columns', async () => {
    mocks.repo.listGuestTicketRows.mockResolvedValue([
      ticketRow({ payment_method: null, payment_id: null, registration_status: null, amount_total: null }),
    ]);
    mocks.getSurveyResponsesForTickets.mockResolvedValue(surveyMap({ tkt_1: { name: 'Plain Name' } }));

    const { guests } = await listEventGuests(EVENT_ID, ORGANIZER_DID);

    expect(guests[0]).toMatchObject({
      attendeeName: 'Plain Name',
      paymentMethod: null,
      paymentId: null,
      registrationStatus: null,
      orderAmountTotal: null,
      holdExpiresAt: null,
      lastEmailSentAt: null,
      fairSettlement: null,
    });
  });

  it('returns a null profile and resolves no DIDs for a ticket with no owner or buyer', async () => {
    mocks.repo.listGuestTicketRows.mockResolvedValue([ticketRow({ owner_did: null, buyer_did: null })]);

    const { guests } = await listEventGuests(EVENT_ID, ORGANIZER_DID);

    expect(guests[0].profile).toBeNull();
    expect(guests[0].resolvedName).toBeNull();
    expect(mocks.resolveProfiles).toHaveBeenCalledWith([]);
  });

  it('exposes a profile without an email as null', async () => {
    mocks.repo.listGuestTicketRows.mockResolvedValue([ticketRow({ buyer_did: null })]);
    mocks.resolveProfiles.mockResolvedValue(profileMap(profile(OWNER_DID, 'Owner Name', 'h')));

    const { guests } = await listEventGuests(EVENT_ID, ORGANIZER_DID);

    expect(guests[0].profile).toEqual({ name: 'Owner Name', handle: 'h', avatar: null, email: null });
  });

  it('propagates unexpected failures untouched', async () => {
    mocks.repo.listGuestTicketRows.mockRejectedValue(new Error('boom'));

    await expect(listEventGuests(EVENT_ID, ORGANIZER_DID)).rejects.toThrow('boom');
  });
});

describe('getGuestSummary', () => {
  it('counts totals, pending/complete registrations and cancelled tickets', async () => {
    mocks.repo.listGuestExportRows.mockResolvedValue([
      exportRow({ status: 'cancelled' }),
      exportRow({ id: 'tkt_2', registration_status: 'pending' }),
      exportRow({ id: 'tkt_3', status: 'refunded', registration_status: null }),
    ]);

    const summary = await getGuestSummary(EVENT_ID, ORGANIZER_DID, { includeCancelled: true, callerCookie: COOKIE });

    expect(summary).toEqual({ total: 3, valid: 1, pendingRegistration: 1, completeRegistration: 1, cancelled: 2 });
    expect(mocks.repo.listGuestExportRows).toHaveBeenCalledWith(EVENT_ID, true);
    expect(mocks.isEventOrganizer).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, COOKIE);
    expect(mocks.resolveProfiles).not.toHaveBeenCalled();
  });

  it('excludes cancelled tickets by default', async () => {
    await getGuestSummary(EVENT_ID, ORGANIZER_DID);

    expect(mocks.repo.listGuestExportRows).toHaveBeenCalledWith(EVENT_ID, false);
  });

  it('is forbidden for a non-organizer and 404 for an unknown event', async () => {
    mocks.isEventOrganizer.mockResolvedValue({ authorized: false });
    expect(await thrown(getGuestSummary(EVENT_ID, ORGANIZER_DID))).toMatchObject({ status: 403, message: 'Forbidden' });
    expect(mocks.repo.getEventTitle).not.toHaveBeenCalled();

    mocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'cohost' });
    mocks.repo.getEventTitle.mockResolvedValue(null);
    expect(await thrown(getGuestSummary(EVENT_ID, ORGANIZER_DID))).toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'Event not found',
    });
  });
});

describe('buildGuestCsv', () => {
  it('writes a BOM-prefixed CSV with identity-resolved attendee, proof of payment and a dated filename', async () => {
    mocks.repo.listGuestExportRows.mockResolvedValue([exportRow()]);
    mocks.resolveProfiles.mockResolvedValue(profileMap(OWNER_PROFILE, BUYER_PROFILE));

    const { filename, content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);
    const [header, row] = csvLines(content);

    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(filename).toMatch(/^test-event-guests-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(header).toBe(
      'Ticket ID,Order ID,Payment ID,Guest Full Name,Guest Email,Ticket Type,Proof of Payment,Status,Registration Status,Guest Of,Purchased At,Owner DID',
    );
    expect(row).toBe(
      `tkt_1,ord_1,pi_1,Owner Name,owner@example.com,General,stripe / paid,valid,complete,Buyer Name,2026-01-02T10:00:00.000Z,${OWNER_DID}`,
    );
    expect(mocks.resolveProfiles).toHaveBeenCalledWith([OWNER_DID, BUYER_DID]);
    expect(mocks.repo.listGuestExportRows).toHaveBeenCalledWith(EVENT_ID, false);
  });

  it('falls back to the buyer identity, and uses the event id when the title is empty', async () => {
    mocks.repo.getEventTitle.mockResolvedValue({ id: EVENT_ID, title: null });
    mocks.repo.listGuestExportRows.mockResolvedValue([exportRow({ owner_did: null })]);
    mocks.resolveProfiles.mockResolvedValue(profileMap(BUYER_PROFILE));

    const { filename, content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);

    expect(filename).toMatch(/^evt_1-guests-/);
    // Email only comes from the survey, owner identity or the order's buyer_email — not the buyer profile.
    expect(csvLines(content)[1]).toContain('pi_1,Buyer Name,,General');
  });

  it('falls back to the event id when the title has no usable characters', async () => {
    mocks.repo.getEventTitle.mockResolvedValue({ id: EVENT_ID, title: '!!!' });

    const { filename } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);

    expect(filename).toMatch(/^evt_1-guests-/);
  });

  it('slugifies the title for the filename', async () => {
    mocks.repo.getEventTitle.mockResolvedValue({ id: EVENT_ID, title: '  Summer Gala: 2026! ' });

    const { filename } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);

    expect(filename).toMatch(/^summer-gala-2026-guests-/);
  });

  it('adds one Survey column per dykil form field and fills it from the ticket response', async () => {
    mocks.repo.listGuestExportRows.mockResolvedValue([exportRow({ registration_form_id: 'form_1' })]);
    mocks.getSurveyResponsesForTickets.mockResolvedValue(
      surveyMap({ tkt_1: { full_name: 'Survey Name', diet: 'vegan' } }),
    );
    mocks.getSurveyForms.mockResolvedValue(
      new Map([['form_1', { id: 'form_1', fields: [{ name: 'diet', title: 'Dietary needs' }] }]]),
    );

    const { content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);
    const [header, row] = csvLines(content);

    expect(mocks.getSurveyForms).toHaveBeenCalledWith(['form_1']);
    expect(header).toContain('Survey: Dietary needs,Owner DID');
    expect(row).toContain('Survey Name');
    expect(row).toContain('vegan');
  });

  it('shows cancelled tickets with their raw status', async () => {
    mocks.repo.listGuestExportRows.mockResolvedValue([exportRow({ status: 'cancelled' })]);

    const { content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID, { includeCancelled: true });

    expect(csvLines(content)[1]).toContain('stripe / cancelled,cancelled');
    expect(mocks.repo.listGuestExportRows).toHaveBeenCalledWith(EVENT_ID, true);
  });

  it('leaves optional columns empty when the ticket has no order, payment or purchase date', async () => {
    mocks.repo.listGuestExportRows.mockResolvedValue([
      exportRow({
        order_id: null,
        payment_method: null,
        ticket_payment_id: null,
        registration_status: null,
        purchased_at: null,
        owner_did: null,
        buyer_did: null,
      }),
    ]);

    const { content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);

    expect(csvLines(content)[1]).toBe('tkt_1,,,,,General,,valid,,,,');
  });

  it.each([
    ['free', { payment_method: 'free' }, 'free / n/a', ''],
    ['pending etransfer', { payment_method: 'etransfer' }, 'etransfer / pending', ''],
    [
      'confirmed etransfer (string date)',
      { payment_method: 'etransfer', payment_confirmed_at: '2026-02-03T09:00:00.000Z' },
      'etransfer / confirmed 2026-02-03',
      '',
    ],
    [
      'confirmed etransfer (Date)',
      { payment_method: 'etransfer', payment_confirmed_at: new Date('2026-03-04T09:00:00.000Z') },
      'etransfer / confirmed 2026-03-04',
      '',
    ],
    ['order payment id', { ticket_payment_id: null, order_payment_id: 'op_1' }, 'stripe / paid', 'op_1'],
    ['stripe session id', { ticket_payment_id: null, stripe_session_id: 'cs_1' }, 'stripe / paid', 'cs_1'],
  ])('derives proof of payment and payment id for %s', async (_label, overrides, proof, paymentId) => {
    mocks.repo.listGuestExportRows.mockResolvedValue([exportRow(overrides)]);

    const { content } = await buildGuestCsv(EVENT_ID, ORGANIZER_DID);
    const cells = csvLines(content)[1].split(',');

    expect(cells[2]).toBe(paymentId);
    expect(cells[6]).toBe(proof);
  });

  it('is forbidden for a non-organizer and 404 for an unknown event', async () => {
    mocks.isEventOrganizer.mockResolvedValue({ authorized: false });
    expect(await thrown(buildGuestCsv(EVENT_ID, ORGANIZER_DID))).toMatchObject({ status: 403 });
    expect(mocks.resolveProfiles).not.toHaveBeenCalled();

    mocks.isEventOrganizer.mockResolvedValue({ authorized: true, role: 'creator' });
    mocks.repo.getEventTitle.mockResolvedValue(null);
    expect(await thrown(buildGuestCsv(EVENT_ID, ORGANIZER_DID))).toMatchObject({ status: 404, message: 'Event not found' });
  });
});

describe('listAttendingEvents', () => {
  const later = new Date('2027-01-01T00:00:00.000Z');

  it('merges ticketed, created and co-hosted events, de-duplicated and sorted by start', async () => {
    mocks.repo.listTicketedEvents.mockResolvedValue([attendingRow('e2', { startsAt: later })]);
    mocks.repo.listCreatedEvents.mockResolvedValue([
      attendingRow('e1', { endsAt: new Date('2026-12-01T22:00:00.000Z'), venue: 'Hall', imageUrl: 'a.png' }),
      attendingRow('e2', { startsAt: later }),
    ]);
    mocks.listMemberPodIds.mockResolvedValue(['pod_1']);
    mocks.repo.listPodEvents.mockResolvedValue([attendingRow('e1'), attendingRow('e3', { startsAt: new Date('2026-11-01T00:00:00.000Z') })]);

    const result = await listAttendingEvents(OWNER_DID, null, COOKIE);

    expect(mocks.listMemberPodIds).toHaveBeenCalledWith(COOKIE);
    expect(result.map((r) => r.eventId)).toEqual(['e3', 'e1', 'e2']);
    expect(result[1]).toEqual({
      eventId: 'e1',
      title: 'Event e1',
      startDate: '2026-12-01T20:00:00.000Z',
      endDate: '2026-12-01T22:00:00.000Z',
      venue: 'Hall',
      imageUrl: 'a.png',
    });
    expect(result[0]).toMatchObject({ endDate: null, venue: null, imageUrl: null });
  });

  it('hides invite-only events from a viewer without a ticket, but keeps the owner\'s own', async () => {
    mocks.repo.listTicketedEvents.mockResolvedValue([attendingRow('priv_ticket', { accessMode: 'invite_only' })]);
    mocks.repo.listCreatedEvents.mockResolvedValue([attendingRow('priv_created', { accessMode: 'invite_only' })]);
    mocks.listMemberPodIds.mockResolvedValue(['pod_1']);
    mocks.repo.listPodEvents.mockResolvedValue([attendingRow('priv_cohost', { accessMode: 'invite_only' })]);

    const result = await listAttendingEvents(OWNER_DID, null);

    expect(result.map((r) => r.eventId).sort()).toEqual(['priv_cohost', 'priv_created']);
    expect(mocks.repo.listHeldEventIds).not.toHaveBeenCalled();
  });

  it('shows an invite-only event to a viewer who also holds a ticket', async () => {
    mocks.repo.listTicketedEvents.mockResolvedValue([
      attendingRow('priv_a', { accessMode: 'invite_only' }),
      attendingRow('priv_b', { accessMode: 'invite_only' }),
      attendingRow('pub'),
    ]);
    mocks.repo.listHeldEventIds.mockResolvedValue(['priv_a']);

    const result = await listAttendingEvents(OWNER_DID, 'did:imajin:viewer');

    expect(mocks.repo.listHeldEventIds).toHaveBeenCalledWith('did:imajin:viewer', ['priv_a', 'priv_b']);
    expect(result.map((r) => r.eventId).sort()).toEqual(['priv_a', 'pub']);
  });

  it('skips the co-host lookup when the caller is in no pods', async () => {
    await listAttendingEvents(OWNER_DID, null);

    expect(mocks.repo.listPodEvents).not.toHaveBeenCalled();
  });

  it('treats a co-host lookup failure as non-fatal and logs a warning', async () => {
    mocks.repo.listTicketedEvents.mockResolvedValue([attendingRow('e1')]);
    mocks.listMemberPodIds.mockRejectedValue(new Error('kernel down'));

    const result = await listAttendingEvents(OWNER_DID, null);

    expect(result.map((r) => r.eventId)).toEqual(['e1']);
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: 'Error: kernel down' },
      'Failed to fetch cohost events (non-fatal)',
    );
  });

  it('propagates a failure of the primary ticket query', async () => {
    mocks.repo.listTicketedEvents.mockRejectedValue(new Error('db down'));

    await expect(listAttendingEvents(OWNER_DID, null)).rejects.toThrow('db down');
  });
});
