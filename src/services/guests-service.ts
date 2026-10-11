import { createLogger } from '@ima-jin/logger';
import { resolveAttendee } from '@/lib/attendee';
import { buildSurveyValues, csvRow, loadSurveyFormData } from '@/lib/guest-export-helpers';
import { listMemberPodIds, resolveProfiles, type ResolvedProfile } from '@/lib/kernel';
import { getSurveyResponsesForTickets, type SurveyAnswers, type SurveyResponse } from '@/lib/surveys';
import {
  getEventTitle,
  listCreatedEvents,
  listGuestExportRows,
  listGuestTicketRows,
  listHeldEventIds,
  listPodEvents,
  listTicketedEvents,
  type AttendingEventRow,
  type GuestExportRow,
  type DateLike,
  type GuestTicketRow,
} from '@/repositories/guests-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';

const log = createLogger('events');

const FORBIDDEN_MESSAGE = 'Forbidden';
const CSV_BOM = '\uFEFF';
const INACTIVE_STATUSES = new Set(['cancelled', 'refunded']);
const EXPORT_HEADERS = [
  'Ticket ID',
  'Order ID',
  'Payment ID',
  'Guest Full Name',
  'Guest Email',
  'Ticket Type',
  'Proof of Payment',
  'Status',
  'Registration Status',
  'Guest Of',
  'Purchased At',
];

type TicketLike = { owner_did: string | null; buyer_did: string | null; buyer_email: string | null };

export interface GuestListEntry {
  id: string;
  status: string;
  ownerDid: string | null;
  pricePaid: number | null;
  currency: string | null;
  purchasedAt: DateLike | null;
  usedAt: DateLike | null;
  ticketType: string;
  paymentMethod: string | null;
  paymentId: string | null;
  holdExpiresAt: DateLike | null;
  profile: { name: string | null; handle: string | null; avatar: null; email: string | null } | null;
  registrationStatus: string | null;
  attendeeName: string | null;
  resolvedName: string | null;
  resolvedEmail: string | null;
  guestOf: string | null;
  lastEmailSentAt: DateLike | null;
  fairSettlement: unknown;
  orderAmountTotal: number | null;
}

export interface GuestList {
  guests: GuestListEntry[];
  isOwner: boolean;
}

export interface GuestSummary {
  total: number;
  valid: number;
  pendingRegistration: number;
  completeRegistration: number;
  cancelled: number;
}

export interface GuestCsv {
  filename: string;
  /** UTF-8 CSV text, prefixed with a BOM so spreadsheets detect the encoding. */
  content: string;
}

export interface GuestExportOptions {
  includeCancelled?: boolean;
  callerCookie?: string | null;
}

export interface AttendingEvent {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string | null;
  venue: string | null;
  imageUrl: string | null;
}

async function assertOrganizer(eventId: string, did: string, callerCookie?: string | null): Promise<void> {
  const check = await isEventOrganizer(eventId, did, callerCookie);
  if (!check.authorized) throw new ServiceError('forbidden', FORBIDDEN_MESSAGE);
}

function resolveIdentities(rows: TicketLike[]): Promise<Map<string, ResolvedProfile>> {
  const dids = new Set<string>();
  for (const row of rows) {
    if (row.owner_did) dids.add(row.owner_did);
    if (row.buyer_did) dids.add(row.buyer_did);
  }
  return resolveProfiles([...dids]);
}

function surveyNameOf(answers: SurveyAnswers): string | null {
  return answers.full_name || answers.name || null;
}

function attendeeFor(row: TicketLike, answers: SurveyAnswers, identities: Map<string, ResolvedProfile>) {
  const owner = row.owner_did ? identities.get(row.owner_did) : undefined;
  const buyer = row.buyer_did ? identities.get(row.buyer_did) : undefined;
  const resolved = resolveAttendee({
    surveyName: surveyNameOf(answers),
    surveyEmail: answers.email || null,
    identityName: owner?.displayName || null,
    identityContactEmail: owner?.email || null,
    identityCredentialEmail: null,
    profileName: null,
    profileEmail: null,
    buyerName: buyer?.displayName || null,
    buyerEmail: row.buyer_email || null,
  });
  return { owner, resolved };
}

function toGuestEntry(
  row: GuestTicketRow,
  surveys: Map<string, SurveyResponse>,
  identities: Map<string, ResolvedProfile>,
): GuestListEntry {
  const answers = surveys.get(row.id)?.answers ?? {};
  const { owner, resolved } = attendeeFor(row, answers, identities);
  return {
    id: row.id,
    status: row.status,
    ownerDid: row.owner_did,
    pricePaid: row.price_paid,
    currency: row.currency,
    purchasedAt: row.purchased_at,
    usedAt: row.used_at,
    ticketType: row.ticket_type,
    paymentMethod: row.payment_method ?? null,
    paymentId: row.payment_id ?? null,
    holdExpiresAt: row.hold_expires_at ?? null,
    profile: owner ? { name: owner.displayName, handle: owner.handle, avatar: null, email: owner.email ?? null } : null,
    registrationStatus: row.registration_status ?? null,
    attendeeName: surveyNameOf(answers),
    resolvedName: resolved.name || null,
    resolvedEmail: resolved.email || null,
    guestOf: resolved.guestOf || null,
    lastEmailSentAt: row.last_email_sent_at ?? null,
    fairSettlement: row.fair_settlement ?? null,
    orderAmountTotal: row.amount_total ?? null,
  };
}

/**
 * The organizer's guest list for an event: ticket rows, survey answers (dykil
 * public API) and batched owner/buyer identity resolution (kernel).
 * Throws `forbidden` unless `actorDid` is the creator or a co-host.
 */
export async function listEventGuests(
  eventId: string,
  actorDid: string,
  callerCookie?: string | null,
): Promise<GuestList> {
  await assertOrganizer(eventId, actorDid, callerCookie);
  const rows = await listGuestTicketRows(eventId);
  const surveys = await getSurveyResponsesForTickets(
    rows.map((t) => ({ ticketId: t.id, formId: t.registration_form_id })),
  );
  const identities = await resolveIdentities(rows);
  return { guests: rows.map((row) => toGuestEntry(row, surveys, identities)), isOwner: true };
}

async function loadExportRows(
  eventId: string,
  actorDid: string,
  options: GuestExportOptions,
): Promise<{ event: { id: string; title: string | null }; rows: GuestExportRow[] }> {
  await assertOrganizer(eventId, actorDid, options.callerCookie);
  const event = await getEventTitle(eventId);
  if (!event) throw new ServiceError('not_found', 'Event not found');
  const rows = await listGuestExportRows(eventId, options.includeCancelled ?? false);
  return { event, rows };
}

/** Registration/cancellation counts for the guest export (`?summary=1`). */
export async function getGuestSummary(
  eventId: string,
  actorDid: string,
  options: GuestExportOptions = {},
): Promise<GuestSummary> {
  const { rows } = await loadExportRows(eventId, actorDid, options);
  const cancelled = rows.filter((t) => INACTIVE_STATUSES.has(t.status)).length;
  return {
    total: rows.length,
    valid: rows.length - cancelled,
    pendingRegistration: rows.filter((t) => t.registration_status === 'pending').length,
    completeRegistration: rows.filter((t) => t.registration_status === 'complete').length,
    cancelled,
  };
}

function proofOfPayment(method: string | null, status: string, confirmedAt: DateLike | null): string {
  if (!method) return '';
  if (method === 'free') return 'free / n/a';
  if (method === 'etransfer') {
    if (!confirmedAt) return 'etransfer / pending';
    const iso = typeof confirmedAt === 'string' ? confirmedAt : new Date(confirmedAt).toISOString();
    return `etransfer / confirmed ${iso.split('T')[0]}`;
  }
  return `${method} / ${status === 'valid' ? 'paid' : status}`;
}

function paymentIdOf(row: GuestExportRow): string {
  if (row.payment_method === 'etransfer' || row.payment_method === 'free') return '';
  return row.ticket_payment_id || row.order_payment_id || row.stripe_session_id || '';
}

function safeFilename(event: { id: string; title: string | null }): string {
  const base = event.title
    ? event.title.replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').toLowerCase()
    : event.id;
  const date = new Date().toISOString().split('T')[0];
  return `${base || event.id}-guests-${date}.csv`;
}

/** Guest-list CSV (one row per ticket, plus one column per survey question). */
export async function buildGuestCsv(
  eventId: string,
  actorDid: string,
  options: GuestExportOptions = {},
): Promise<GuestCsv> {
  const { event, rows } = await loadExportRows(eventId, actorDid, options);
  const identities = await resolveIdentities(rows);
  const surveys = await getSurveyResponsesForTickets(
    rows.map((t) => ({ ticketId: t.id, formId: t.registration_form_id })),
  );
  const formIds = [...new Set(rows.map((t) => t.registration_form_id).filter(Boolean))] as string[];
  const { surveyColumns, formFieldMap } = await loadSurveyFormData(formIds);

  const lines = [csvRow([...EXPORT_HEADERS, ...surveyColumns, 'Owner DID'])];
  for (const row of rows) {
    const survey = surveys.get(row.id);
    const answers = survey?.answers ?? {};
    const { resolved } = attendeeFor(row, answers, identities);
    const surveyValues = buildSurveyValues(
      { survey_form_id: survey?.surveyId ?? null, survey_answers: answers },
      surveyColumns,
      formFieldMap,
    );
    lines.push(
      csvRow([
        row.id,
        row.order_id || '',
        paymentIdOf(row),
        resolved.name,
        resolved.email,
        row.ticket_type,
        proofOfPayment(row.payment_method, row.status, row.payment_confirmed_at),
        row.status,
        row.registration_status || '',
        resolved.guestOf,
        row.purchased_at ? new Date(row.purchased_at).toISOString() : '',
        ...surveyValues,
        row.owner_did || '',
      ]),
    );
  }
  return { filename: safeFilename(event), content: CSV_BOM + lines.join('') };
}

/** Co-hosted events (the caller's kernel pods); a kernel/db failure is non-fatal. */
async function listCohostEvents(callerCookie: string | null | undefined, now: Date): Promise<AttendingEventRow[]> {
  try {
    const podIds = await listMemberPodIds(callerCookie);
    return podIds.length === 0 ? [] : await listPodEvents(podIds, now);
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to fetch cohost events (non-fatal)');
    return [];
  }
}

function dedupeByEvent(rows: AttendingEventRow[]): AttendingEventRow[] {
  const seen = new Set<string>();
  const unique: AttendingEventRow[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) continue;
    seen.add(row.eventId);
    unique.push(row);
  }
  return unique;
}

function toAttendingEvent(row: AttendingEventRow): AttendingEvent {
  return {
    eventId: row.eventId,
    title: row.title,
    startDate: row.startsAt.toISOString(),
    endDate: row.endsAt ? row.endsAt.toISOString() : null,
    venue: row.venue ?? null,
    imageUrl: row.imageUrl ?? null,
  };
}

/**
 * Upcoming events `ownerDid` is attending, hosting or co-hosting. Invite-only
 * events show up only for the owner's own (created / co-hosted) events or when
 * `viewerDid` also holds a ticket.
 */
export async function listAttendingEvents(
  ownerDid: string,
  viewerDid: string | null,
  callerCookie?: string | null,
): Promise<AttendingEvent[]> {
  const now = new Date();
  const ticketed = await listTicketedEvents(ownerDid, now);
  const created = await listCreatedEvents(ownerDid, now);
  const cohosted = await listCohostEvents(callerCookie, now);

  const all = dedupeByEvent([...ticketed, ...created, ...cohosted]);
  const publicEvents = all.filter((r) => r.accessMode === 'public');
  const privateEvents = all.filter((r) => r.accessMode !== 'public');

  let visible = publicEvents;
  if (privateEvents.length > 0) {
    const owned = new Set([...created, ...cohosted].map((r) => r.eventId));
    const held = viewerDid
      ? new Set(
          await listHeldEventIds(
            viewerDid,
            privateEvents.map((r) => r.eventId),
          ),
        )
      : new Set<string>();
    visible = [...publicEvents, ...privateEvents.filter((r) => owned.has(r.eventId) || held.has(r.eventId))];
  }

  const ordered = visible.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return ordered.map(toAttendingEvent);
}
