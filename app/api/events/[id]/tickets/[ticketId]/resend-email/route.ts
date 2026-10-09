import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';

const log = createLogger('events');
import { eq, and } from 'drizzle-orm';
import { getContactEmail as resolveEmailForDid } from '@/lib/kernel';
import { getSurveyResponseForTicket } from '@/lib/ticket-survey';
import { db, tickets, events, ticketTypes } from '@/db';
import { generateQRCode } from '@/lib/email';
import { publish } from '@/lib/domain-events';

import { eventUrl, eventRegisterUrl, eventMyTicketsUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import { authenticateActing, forbidUnlessOrganizer, type TicketParams } from '@/lib/route-helpers';

const EVENTS_URL = buildPublicUrlAbsolute('events');

function redactEmail(email: string): string {
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return '***';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  const redacted = local.length > 2
    ? `${local[0]}***${local.at(-1)}`
    : '***';
  return `${redacted}@${domain}`;
}

/** Guard: reject resends within the 3-day cooldown window, returning the error response or null. */
function checkResendCooldown(lastEmailSentAt: Date | string | null): NextResponse | null {
  if (!lastEmailSentAt) return null;
  const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - new Date(lastEmailSentAt).getTime();
  if (elapsed >= COOLDOWN_MS) return null;
  const hoursLeft = Math.ceil((COOLDOWN_MS - elapsed) / (60 * 60 * 1000));
  return NextResponse.json(
    { error: `Email was recently sent. Try again in ~${hoursLeft}h.`, lastEmailSentAt },
    { status: 429 }
  );
}

interface SurveyAnswers {
  email?: string;
  full_name?: string;
  name?: string;
}

interface ResendEmailContext {
  ticket: typeof tickets.$inferSelect;
  event: typeof events.$inferSelect;
  ticketType: typeof ticketTypes.$inferSelect;
  surveyResponse: { answers?: SurveyAnswers } | undefined;
}

/** Load the ticket/event/ticket-type/survey-response needed to resend an email, or an error response. */
async function loadResendContext(eventId: string, ticketId: string): Promise<ResendEmailContext | NextResponse> {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
    .limit(1);
  if (!ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  const cooldownError = checkResendCooldown(ticket.lastEmailSentAt);
  if (cooldownError) return cooldownError;

  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  const [ticketType] = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, ticket.ticketTypeId))
    .limit(1);
  if (!ticketType) {
    return NextResponse.json({ error: 'Ticket type not found' }, { status: 404 });
  }

  const surveyResponse = (await getSurveyResponseForTicket(ticketId)) ?? undefined;

  return { ticket, event, ticketType, surveyResponse };
}

/**
 * Determine email: survey response email > resolveEmailForDid precedence
 * (auth.credentials -> profile.profiles.contact_email -> auth.identities;
 * #1998 moved this off the raw profile.profiles query this file used to
 * run for itself, onto the profile service's batched /api/resolve route).
 */
async function resolveResendCustomerEmail(surveyResponse: ResendEmailContext['surveyResponse'], ownerDid: string | null): Promise<string | null> {
  if (surveyResponse?.answers?.email) {
    return surveyResponse.answers.email;
  }
  if (ownerDid) {
    return resolveEmailForDid(ownerDid);
  }
  return null;
}

/**
 * Deep link to the ticket's registration (or my-tickets) page for the email.
 *
 * gap(kernel): the kernel version minted an `auth.onboard_tokens` magic link
 * here so a soft-DID buyer could sign in from the email. A registered app
 * cannot mint one (see `createOnboardToken` in src/lib/kernel.ts), so the
 * email carries the plain deep link — the buyer signs in on arrival.
 */
function resendTicketLink(ctx: ResendEmailContext): string {
  const { ticket, event } = ctx;
  return ticket.registrationStatus === 'pending'
    ? eventRegisterUrl(EVENTS_URL, event.id, ticket.id)
    : eventMyTicketsUrl(EVENTS_URL, event.id);
}

function formatEventDateTime(startsAt: string | Date): { formattedEventDate: string; formattedEventTime: string } {
  const eventDate = new Date(startsAt);
  return {
    formattedEventDate: eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    formattedEventTime: eventDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  };
}

function resolveEventImageUrl(imageUrl: string | null): string | undefined {
  if (!imageUrl) return undefined;
  return imageUrl.startsWith('http') ? imageUrl : `${EVENTS_URL}${imageUrl}`;
}

/** Publish either a registration reminder or a ticket-confirmed notification, depending on registration status. */
async function publishResendNotification(ctx: ResendEmailContext, did: string, customerEmail: string, magicLink: string): Promise<void> {
  const { ticket, event, ticketType } = ctx;
  const { formattedEventDate, formattedEventTime } = formatEventDateTime(event.startsAt);
  const eventImageUrl = resolveEventImageUrl(event.imageUrl);

  if (ticket.registrationStatus === 'pending') {
    publish('ticket.registration.reminder', {
      issuer: did,
      subject: ticket.ownerDid || '',
      scope: 'events',
      payload: {
        email: customerEmail,
        eventTitle: event.title,
        eventDate: formattedEventDate,
        pendingCount: 1,
        registrationUrl: magicLink,
        eventImageUrl,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ err: String(err) }, 'Registration reminder publish error'));
    return;
  }

  const qrCodeDataUri = await generateQRCode(ticket.id);
  const formattedPrice =
    ticket.pricePaid === null
      ? 'Free'
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: (ticket.currency || 'USD').toUpperCase(),
        }).format(ticket.pricePaid / 100);

  publish('ticket.confirmed', {
    issuer: did,
    subject: ticket.ownerDid || '',
    scope: 'events',
    payload: {
      email: customerEmail,
      eventTitle: event.title,
      ticketType: ticketType.name,
      ticketId: ticket.id,
      eventDate: formattedEventDate,
      eventTime: formattedEventTime,
      isVirtual: event.isVirtual ?? false,
      venue: event.venue ?? undefined,
      price: formattedPrice,
      magicLink,
      eventImageUrl,
      eventUrl: eventUrl(EVENTS_URL, event.id),
      qrCodeDataUri,
      context_id: event.id,
      context_type: 'event',
    },
  }).catch((err) => log.error({ err: String(err) }, 'Ticket confirmed publish error'));
}

export async function POST(
  request: NextRequest,
  { params }: TicketParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;
  const { id: eventId, ticketId } = await params;

  try {
    const forbidden = await forbidUnlessOrganizer(eventId, did, request, 'Forbidden');
    if (forbidden) return forbidden;

    const ctx = await loadResendContext(eventId, ticketId);
    if (ctx instanceof NextResponse) return ctx;

    const customerEmail = await resolveResendCustomerEmail(ctx.surveyResponse, ctx.ticket.ownerDid);
    if (!customerEmail) {
      return NextResponse.json(
        { error: 'Could not determine email address for this ticket' },
        { status: 422 }
      );
    }

    const magicLink = resendTicketLink(ctx);
    await publishResendNotification(ctx, did, customerEmail, magicLink);

    // Record the send timestamp
    const sentAt = new Date().toISOString();
    await db
      .update(tickets)
      .set({ lastEmailSentAt: new Date(sentAt) })
      .where(eq(tickets.id, ticketId));

    return NextResponse.json({ success: true, email: redactEmail(customerEmail), lastEmailSentAt: sentAt });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resend ticket email');
    return NextResponse.json({ error: 'Failed to resend email' }, { status: 500 });
  }
}
