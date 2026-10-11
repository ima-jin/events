/**
 * Buyer notifications for a confirmed e-Transfer purchase: a receipt and a
 * ticket bundle, both published as domain events (the kernel reactors deliver
 * the actual e-mail).
 */
import { eventUrl, eventRegisterUrl, eventMyTicketsUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import { createLogger } from '@ima-jin/logger';
import type { Event, Ticket, TicketType } from '@/db/schema';
import { publish } from '@/lib/domain-events';
import { generateQRCode } from '@/lib/email';
import { createOnboardToken, publicServiceUrl, resolveProfiles } from '@/lib/kernel';
import { findOrderById } from '@/repositories/orders-repository';
import { findTicketTypesByIds } from '@/repositories/ticket-types-repository';

const log = createLogger('events');

const SCOPE = 'events';
const CONTEXT_TYPE = 'event';
const DEFAULT_CURRENCY = 'CAD';
const DEFAULT_TICKET_NAME = 'Ticket';

interface SummaryLine {
  typeName: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

type Formatter = (cents: number) => string;

/** Resolve buyer contact details from the kernel profile resolver, falling back to the order's buyer email. */
async function resolveBuyerContact(
  buyerDid: string | null,
  orderId: string | null,
): Promise<{ email: string | null; name: string | null }> {
  let customerEmail: string | null = null;
  let customerName: string | null = null;

  if (buyerDid) {
    const profile = (await resolveProfiles([buyerDid])).get(buyerDid);
    customerEmail = profile?.email ?? null;
    customerName = profile?.displayName ?? null;
  }

  if (!customerEmail && orderId) {
    const order = await findOrderById(orderId);
    customerEmail = order?.buyerEmail ?? null;
  }

  return { email: customerEmail, name: customerName };
}

/** Build ticket type lookup + purchase summary for the email. */
async function buildTicketSummary(confirmedTickets: Ticket[]) {
  const typeIds = Array.from(new Set(confirmedTickets.map((t) => t.ticketTypeId)));
  const typeRows = await findTicketTypesByIds(typeIds);
  const typesById = new Map<string, TicketType>(typeRows.map((t) => [t.id, t]));

  const summary = new Map<string, SummaryLine>();
  let totalCents = 0;
  for (const t of confirmedTickets) {
    const tt = typesById.get(t.ticketTypeId);
    const existing = summary.get(t.ticketTypeId);
    if (existing) {
      existing.quantity += 1;
    } else {
      summary.set(t.ticketTypeId, {
        typeName: tt?.name ?? DEFAULT_TICKET_NAME,
        quantity: 1,
        unitPrice: t.pricePaid ?? tt?.price ?? 0,
        currency: t.currency || tt?.currency || DEFAULT_CURRENCY,
      });
    }
    totalCents += t.pricePaid ?? tt?.price ?? 0;
  }
  return { typesById, summary, totalCents };
}

function formatEventTiming(event: Event): { date: string; time: string } {
  const eventDate = new Date(event.startsAt);
  return {
    date: eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    time: eventDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  };
}

function resolveEventImageUrl(event: Event, eventsUrl: string): string | undefined {
  if (!event.imageUrl) {
    return undefined;
  }
  return event.imageUrl.startsWith('http') ? event.imageUrl : `${eventsUrl}${event.imageUrl}`;
}

/** Magic link (onboard token when the kernel mints one) + the CTA url for the receipt. */
async function resolveLinks(
  event: Event,
  eventsUrl: string,
  registrationPending: Ticket[],
): Promise<{ magicLink: string; registrationUrl: string }> {
  const onboardToken = await createOnboardToken();
  const magicLink = onboardToken
    ? `${publicServiceUrl('auth')}/api/onboard/verify?token=${onboardToken}`
    : eventMyTicketsUrl(eventsUrl, event.id);

  if (registrationPending.length === 0) {
    return { magicLink, registrationUrl: eventMyTicketsUrl(eventsUrl, event.id) };
  }
  const registrationUrl = onboardToken
    ? magicLink
    : eventRegisterUrl(eventsUrl, event.id, registrationPending[0].id);
  return { magicLink, registrationUrl };
}

interface EmailContext {
  event: Event;
  customerEmail: string;
  customerName: string | null;
  buyerDid: string | null;
  eventsUrl: string;
  eventDate: string;
  eventTime: string;
  eventImageUrl: string | undefined;
  magicLink: string;
  registrationUrl: string;
  hasRegistrationRequired: boolean;
  fmt: Formatter;
}

function publishReceipt(
  ctx: EmailContext,
  summary: Map<string, SummaryLine>,
  totalCents: number,
): void {
  const { event, buyerDid, customerEmail, customerName, fmt } = ctx;
  publish('ticket.receipt', {
    issuer: buyerDid || '',
    subject: buyerDid || '',
    scope: SCOPE,
    payload: {
      email: customerEmail,
      buyerName: customerName || undefined,
      eventTitle: event.title,
      eventDate: ctx.eventDate,
      eventTime: ctx.eventTime,
      ticketSummary: Array.from(summary.values()).map((s) => ({
        typeName: s.typeName,
        quantity: s.quantity,
        unitPrice: fmt(s.unitPrice),
      })),
      totalPaid: fmt(totalCents),
      paymentMethod: 'E-Transfer',
      registrationUrl: ctx.registrationUrl,
      eventImageUrl: ctx.eventImageUrl,
      hasRegistrationRequired: ctx.hasRegistrationRequired,
      context_id: event.id,
      context_type: CONTEXT_TYPE,
    },
  }).catch((err) => log.error({ err: String(err) }, 'Receipt publish error'));
}

async function publishTicketBundle(
  ctx: EmailContext,
  bundleTickets: Ticket[],
  typesById: Map<string, TicketType>,
): Promise<void> {
  const { event, customerEmail, fmt } = ctx;
  const ticketsWithQr = await Promise.all(
    bundleTickets.map(async (t) => ({ id: t.id, qrCodeDataUri: await generateQRCode(t.id) })),
  );
  const primaryType = typesById.get(bundleTickets[0].ticketTypeId);
  const bundleFormatted = fmt(bundleTickets.reduce((sum, t) => sum + (t.pricePaid ?? 0), 0));

  publish('ticket.confirmed', {
    issuer: bundleTickets[0].ownerDid || '',
    subject: bundleTickets[0].ownerDid || customerEmail,
    scope: SCOPE,
    payload: {
      to: customerEmail,
      email: customerEmail,
      eventTitle: event.title,
      ticketType: primaryType?.name ?? DEFAULT_TICKET_NAME,
      ticketId: bundleTickets[0].id,
      eventDate: ctx.eventDate,
      eventTime: ctx.eventTime,
      isVirtual: event.isVirtual ?? false,
      venue: event.venue ?? undefined,
      price: bundleFormatted,
      magicLink: ctx.magicLink,
      eventImageUrl: ctx.eventImageUrl,
      eventUrl: eventUrl(ctx.eventsUrl, event.id),
      tickets: ticketsWithQr,
      context_id: event.id,
      context_type: CONTEXT_TYPE,
    },
  }).catch((err) => log.error({ err: String(err) }, 'Failed to publish ticket confirmed event'));
}

/** Publish the receipt + ticket-bundle emails for a confirmed EMT purchase. */
export async function sendConfirmationEmails(
  event: Event,
  confirmedTickets: Ticket[],
  orderId: string | null,
): Promise<void> {
  const buyerDid = confirmedTickets[0].ownerDid;
  const { email: customerEmail, name: customerName } = await resolveBuyerContact(buyerDid, orderId);

  if (!customerEmail) {
    log.warn(
      { buyerDid, orderId },
      'No buyer email available on EMT confirm; skipping receipt + ticket emails',
    );
    return;
  }

  const { typesById, summary, totalCents } = await buildTicketSummary(confirmedTickets);
  const currency = confirmedTickets[0].currency || DEFAULT_CURRENCY;
  const fmt: Formatter = (cents) =>
    new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);

  const eventsUrl = buildPublicUrlAbsolute('events');
  const { date, time } = formatEventTiming(event);
  const registrationPending = confirmedTickets.filter((t) => t.registrationStatus === 'pending');
  const { magicLink, registrationUrl } = await resolveLinks(event, eventsUrl, registrationPending);

  const ctx: EmailContext = {
    event,
    customerEmail,
    customerName,
    buyerDid,
    eventsUrl,
    eventDate: date,
    eventTime: time,
    eventImageUrl: resolveEventImageUrl(event, eventsUrl),
    magicLink,
    registrationUrl,
    hasRegistrationRequired: registrationPending.length > 0,
    fmt,
  };

  publishReceipt(ctx, summary, totalCents);

  const bundleTickets = confirmedTickets.filter((t) => t.registrationStatus !== 'pending');
  if (bundleTickets.length > 0) {
    await publishTicketBundle(ctx, bundleTickets, typesById);
  }
}
