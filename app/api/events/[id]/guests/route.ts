import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { resolveProfiles as resolveIdentitiesForDids } from '@/lib/kernel';
import { getSurveyResponsesForTickets } from '@/lib/surveys';
import { corsHeaders } from '@ima-jin/config';

const log = createLogger('events');
import { getClient } from '@/db';
import { resolveAttendee } from '@/lib/attendee';
import { forbidUnlessOrganizer, type IdParams, authenticateAppOrActing } from '@/lib/route-helpers';

const sql = getClient();

/**
 * GET /api/events/[id]/guests — list all tickets with profile info (owner or cohost)
 */
export async function GET(
  request: NextRequest,
  { params }: IdParams
) {
  const cors = corsHeaders(request);
  const auth = await authenticateAppOrActing(request, 'events:read', cors);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;

  const { id } = await params;

  try {
    const forbidden = await forbidUnlessOrganizer(id, did, request, 'Forbidden');
    if (forbidden) return forbidden;

    const ticketRows = await sql`
      SELECT t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
             t.payment_method, t.payment_id, t.hold_expires_at, t.registration_status,
             t.last_email_sent_at,
             tt.name as ticket_type,
             tt.registration_form_id,
             o.fair_settlement, o.amount_total,
             o.buyer_email,
             o.buyer_did
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN events.orders o ON t.order_id = o.id
      WHERE t.event_id = ${id}
      ORDER BY t.created_at DESC
    `;

    // Survey answers come from dykil's public API (never its tables).
    const surveyByTicket = await getSurveyResponsesForTickets(
      ticketRows.map((t) => ({ ticketId: t.id, formId: t.registration_form_id }))
    );

    // Batch-resolve unique owner/buyer DIDs via the kernel's batched
    // profile resolve route (src/lib/kernel.ts).
    const uniqueDids = [...new Set(
      ticketRows.flatMap((t) => [t.owner_did, t.buyer_did]).filter(Boolean)
    )] as string[];
    const resolvedMap = await resolveIdentitiesForDids(uniqueDids);

    const guests = ticketRows.map((t) => {
      const ownerResolved = t.owner_did ? resolvedMap.get(t.owner_did) : undefined;
      const buyerResolved = t.buyer_did ? resolvedMap.get(t.buyer_did) : undefined;

      const surveyAnswers = surveyByTicket.get(t.id)?.answers ?? {};
      const resolved = resolveAttendee({
        surveyName: surveyAnswers.full_name || surveyAnswers.name || null,
        surveyEmail: surveyAnswers.email || null,
        identityName: ownerResolved?.displayName || null,
        identityContactEmail: ownerResolved?.email || null,
        identityCredentialEmail: null,
        profileName: null,
        profileEmail: null,
        buyerName: buyerResolved?.displayName || null,
        buyerEmail: t.buyer_email || null,
      });

      return {
        id: t.id,
        status: t.status,
        ownerDid: t.owner_did,
        pricePaid: t.price_paid,
        currency: t.currency,
        purchasedAt: t.purchased_at,
        usedAt: t.used_at,
        ticketType: t.ticket_type,
        paymentMethod: t.payment_method ?? null,
        paymentId: t.payment_id ?? null,
        holdExpiresAt: t.hold_expires_at ?? null,
        profile: ownerResolved
          ? { name: ownerResolved.displayName, handle: ownerResolved.handle, avatar: null, email: ownerResolved.email ?? null }
          : null,
        registrationStatus: t.registration_status ?? null,
        attendeeName: surveyAnswers.full_name || surveyAnswers.name || null,
        resolvedName: resolved.name || null,
        resolvedEmail: resolved.email || null,
        guestOf: resolved.guestOf || null,
        lastEmailSentAt: t.last_email_sent_at ?? null,
        fairSettlement: t.fair_settlement ?? null,
        orderAmountTotal: t.amount_total ?? null,
      };
    });

    return NextResponse.json({ guests, isOwner: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch guests');
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}
