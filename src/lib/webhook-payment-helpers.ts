import { publicServiceUrl } from '@/lib/kernel';
/**
 * Helpers for the Stripe payment webhook.
 * Extracted from app/api/webhook/payment/route.ts to reduce cognitive complexity.
 */

import type { Logger } from '@ima-jin/logger';
import { publish } from '@/lib/domain-events';
import { eventUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import { generateQRCode } from '@/lib/email';

// ---------------------------------------------------------------------------
// Cart parsing
// ---------------------------------------------------------------------------

export interface CartEntry {
  ticketTypeId: string;
  quantity: number;
}

export interface PaymentMetadata {
  eventId: string;
  eventDid: string;
  ticketTypeId?: string;
  quantity?: string;
  cart?: string;
  totalQuantity?: string;
  buyerDid?: string;
}

/**
 * Parse the cart from Stripe metadata.
 * Accepts either a `cart` JSON string (multi-type) or legacy `ticketTypeId` + `quantity`.
 * Throws on invalid input.
 */
export function parseCartFromMetadata(metadata: PaymentMetadata): CartEntry[] {
  if (metadata.cart) {
    try {
      return JSON.parse(metadata.cart) as CartEntry[];
    } catch {
      throw new Error(`Invalid cart metadata: ${metadata.cart}`);
    }
  }
  if (metadata.ticketTypeId) {
    return [{ ticketTypeId: metadata.ticketTypeId, quantity: Number.parseInt(metadata.quantity || '1') }];
  }
  throw new Error('No cart or ticketTypeId in metadata');
}

// ---------------------------------------------------------------------------
// Onboard token creation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat sync
// ---------------------------------------------------------------------------

/**
 * Add the buyer to the event chat conversation as a member.
 * Non-fatal — logs warnings on failure.
 */
export async function syncBuyerToEventChat(
  chatUrl: string,
  eventDid: string,
  ownerDid: string,
  log: Logger,
): Promise<void> {
  try {
    const memberRes = await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberDid: ownerDid, role: 'member' }),
    });
    if (memberRes.ok) {
      log.info({ ownerDid, eventDid }, 'Added buyer to event chat');
    } else {
      log.warn({ status: memberRes.status }, 'Failed to add to event chat — non-fatal');
    }
  } catch (chatError) {
    log.warn({ err: String(chatError) }, 'Event chat member sync failed (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Confirmation emails
// ---------------------------------------------------------------------------

export interface ConfirmationEmailParams {
  customerEmail: string;
  customerName?: string | null;
  ownerDid: string;
  event: {
    id: string;
    title: string;
    startsAt: Date | string;
    imageUrl?: string | null;
    isVirtual?: boolean | null;
    venue?: string | null;
    did: string;
  };
  firstTypeName: string;
  createdTickets: Array<{
    id: string;
    pricePaid?: number | null;
    registrationStatus?: string | null;
  }>;
  currency: string;
  amountTotal: number;
  paymentId?: string;
  magicLink?: string;
  registrationUrl: string;
  log: Logger;
}

/**
 * Publish the purchase receipt and (for non-registration-pending tickets)
 * the ticket confirmation with QR codes. Fire-and-forget.
 */
export async function publishConfirmationEmails(params: ConfirmationEmailParams): Promise<void> {
  const {
    customerEmail, customerName, ownerDid, event, firstTypeName,
    createdTickets, currency, amountTotal, paymentId, magicLink,
    registrationUrl, log,
  } = params;

  const EVENTS_URL = buildPublicUrlAbsolute('events');
  const AUTH_URL = publicServiceUrl('auth');
  const eventDate = new Date(event.startsAt);
  const formattedEventDate = eventDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const formattedEventTime = eventDate.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const formattedTotal = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(amountTotal / 100);
  const quantity = createdTickets.length;
  const unitPrice = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(amountTotal / 100 / quantity);
  let eventImageUrl: string | undefined;
  if (event.imageUrl) {
    eventImageUrl = event.imageUrl.startsWith('http') ? event.imageUrl : `${EVENTS_URL}${event.imageUrl}`;
  }

  const anyPendingRegistration = createdTickets.some((t) => t.registrationStatus === 'pending');

  publishPurchaseReceipt({
    customerEmail, customerName, ownerDid, event, firstTypeName, quantity, unitPrice,
    formattedTotal, formattedEventDate, formattedEventTime, paymentId, registrationUrl,
    eventImageUrl, anyPendingRegistration, log,
  });

  const bundleTickets = createdTickets.filter((t) => t.registrationStatus !== 'pending');
  if (bundleTickets.length > 0) {
    await publishBundleConfirmation({
      customerEmail, ownerDid, event, firstTypeName, bundleTickets, currency,
      formattedEventDate, formattedEventTime, magicLink, eventImageUrl, EVENTS_URL, AUTH_URL, log,
    });
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface ReceiptParams {
  customerEmail: string;
  customerName?: string | null;
  ownerDid: string;
  event: { id: string; title: string };
  firstTypeName: string;
  quantity: number;
  unitPrice: string;
  formattedTotal: string;
  formattedEventDate: string;
  formattedEventTime: string;
  paymentId?: string;
  registrationUrl: string;
  eventImageUrl?: string;
  anyPendingRegistration: boolean;
  log: Logger;
}

function publishPurchaseReceipt(params: ReceiptParams): void {
  const {
    customerEmail, customerName, ownerDid, event, firstTypeName, quantity, unitPrice,
    formattedTotal, formattedEventDate, formattedEventTime, paymentId, registrationUrl,
    eventImageUrl, anyPendingRegistration, log,
  } = params;

  try {
    publish('ticket.receipt', {
      issuer: ownerDid, subject: ownerDid, scope: 'events',
      payload: {
        email: customerEmail,
        buyerName: customerName || undefined,
        eventTitle: event.title,
        eventDate: formattedEventDate,
        eventTime: formattedEventTime,
        ticketSummary: [{ typeName: firstTypeName, quantity, unitPrice }],
        totalPaid: formattedTotal,
        paymentMethod: paymentId ? 'Credit Card' : 'E-Transfer',
        registrationUrl,
        eventImageUrl,
        hasRegistrationRequired: anyPendingRegistration,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ customerEmail, err: String(err) }, '[webhook] Purchase receipt publish error'));
  } catch (emailError) {
    log.error({ customerEmail, err: String(emailError) }, '[webhook] Purchase receipt publish failed');
  }
}

interface BundleConfirmParams {
  customerEmail: string;
  ownerDid: string;
  event: {
    id: string;
    title: string;
    isVirtual?: boolean | null;
    venue?: string | null;
    did: string;
  };
  firstTypeName: string;
  bundleTickets: Array<{ id: string; pricePaid?: number | null }>;
  currency: string;
  formattedEventDate: string;
  formattedEventTime: string;
  magicLink?: string;
  eventImageUrl?: string;
  EVENTS_URL: string;
  AUTH_URL: string;
  log: Logger;
}

async function publishBundleConfirmation(params: BundleConfirmParams): Promise<void> {
  const {
    customerEmail, ownerDid, event, firstTypeName, bundleTickets, currency,
    formattedEventDate, formattedEventTime, magicLink, eventImageUrl, EVENTS_URL, log,
  } = params;

  try {
    const ticketsWithQr = await Promise.all(
      bundleTickets.map(async (t) => ({
        id: t.id,
        qrCodeDataUri: await generateQRCode(t.id),
      })),
    );
    const bundleCents = bundleTickets.reduce((sum, t) => sum + (t.pricePaid ?? 0), 0);
    const bundleFormatted = new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency.toUpperCase(),
    }).format(bundleCents / 100);

    publish('ticket.confirmed', {
      issuer: ownerDid, subject: ownerDid, scope: 'events',
      payload: {
        to: customerEmail,
        email: customerEmail,
        eventTitle: event.title,
        ticketType: firstTypeName,
        ticketId: bundleTickets[0].id,
        eventDate: formattedEventDate,
        eventTime: formattedEventTime,
        isVirtual: event.isVirtual ?? false,
        venue: event.venue ?? undefined,
        price: bundleFormatted,
        magicLink,
        eventImageUrl,
        eventUrl: eventUrl(EVENTS_URL, event.id),
        tickets: ticketsWithQr,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ customerEmail, err: String(err) }, '[webhook] Ticket confirmed publish error'));
  } catch (emailError) {
    log.error({ customerEmail, err: String(emailError) }, '[webhook] Ticket confirmation publish failed');
  }
}

// Re-export URL helpers for use in the route
export { eventRegisterUrl, eventMyTicketsUrl } from '@ima-jin/config';
export { buildPublicUrlAbsolute };
