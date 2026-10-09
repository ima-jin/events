import { serviceUrl, publicServiceUrl, createOnboardToken } from '@/lib/kernel';
/**
 * POST /api/webhook/payment
 *
 * Called by pay service when a checkout completes.
 * Creates order + ticket records via the shared createOrderWithTickets
 * helper. Webhook-only logic (soft-DID creation, chat member sync, email
 * migration, .fair settlement signals, per-ticket bus publishes, onboard
 * token magic links) stays here.
 */

import { NextResponse } from 'next/server';
import { withLogger, createLogger } from '@ima-jin/logger';
import { db, events, ticketTypes, tickets, orders } from '@/db';

const log = createLogger('events');
import { eq, and, sql } from 'drizzle-orm';
import { backfillContactEmail } from '@/lib/contact-email';
import { createOrderWithTickets } from '@/lib/checkout-common';
import { eventRegisterUrl, eventMyTicketsUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import * as bus from '@/lib/domain-events';
import { settleCompletedOrder } from '@/lib/pay-settle';
import {
  parseCartFromMetadata,
  syncBuyerToEventChat,
  publishConfirmationEmails,
  type CartEntry,
} from '@/lib/webhook-payment-helpers';

// Shared secret between pay service and events service.
// In production, use proper service-to-service auth.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const AUTH_URL = (serviceUrl('auth') ?? '');

/**
 * Resolve or create a soft DID via the auth service.
 * POST /api/session/soft is a server-side DID resolver only — it does not
 * issue session cookies or tokens.
 */
async function createSoftDidSession(email: string, name?: string): Promise<{ did: string } | null> {
  try {
    const response = await fetch(`${AUTH_URL}/api/session/soft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        name: name?.trim(),
      }),
    });

    if (!response.ok) {
      log.error({ status: response.status }, 'Soft session creation failed');
      return null;
    }

    const data = await response.json();
    log.info({ email, did: data.did }, 'Soft DID resolved');
    return { did: data.did };
  } catch (error) {
    log.error({ err: String(error) }, 'Soft session creation error');
    return null;
  }
}

/**
 * Attach email to an existing hard DID profile (if not already set), via the
 * kernel (NULL-guarded server-side). This app never writes `profile.profiles`.
 */
async function attachEmailToProfile(did: string, email: string): Promise<void> {
  await backfillContactEmail(did, email, log);
  log.info({ did }, 'Requested contact email attach for hard DID');
}

/**
 * Migrate tickets and chat participation from soft DIDs to a hard DID.
 * Looks up tickets by purchaseEmail in metadata (since soft DIDs are did:imajin:* not did:email:*).
 * Only migrates tickets not already owned by the hard DID.
 */
async function migrateSoftDidToHard(email: string, hardDid: string, eventId: string): Promise<void> {
  try {
    const softTickets = await db
      .select({ id: tickets.id, ownerDid: tickets.ownerDid })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          sql`${tickets.metadata}->>'purchaseEmail' = ${email.toLowerCase().trim()}`,
          sql`${tickets.ownerDid} != ${hardDid}`
        )
      );

    if (softTickets.length === 0) return;

    const softDids = Array.from(new Set(softTickets.map(t => t.ownerDid)));

    await db
      .update(tickets)
      .set({ ownerDid: hardDid })
      .where(
        and(
          eq(tickets.eventId, eventId),
          sql`${tickets.metadata}->>'purchaseEmail' = ${email.toLowerCase().trim()}`,
          sql`${tickets.ownerDid} != ${hardDid}`
        )
      );

    log.info({ count: softTickets.length, softDids, hardDid }, 'Migrated tickets from soft DIDs to hard DID');

    const CHAT_URL = serviceUrl('chat');
    if (CHAT_URL) {
      await Promise.all(
        softDids.map(async (softDid) => {
          try {
            await fetch(`${CHAT_URL}/api/participants/migrate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fromDid: softDid, toDid: hardDid }),
            });
            log.info({ softDid, hardDid }, 'Migrated chat participation');
          } catch (chatError) {
            log.warn({ softDid, err: String(chatError) }, 'Chat migration failed (non-fatal)');
          }
        })
      );
    }
  } catch (error) {
    log.error({ err: String(error) }, 'migrateSoftDidToHard error');
  }
}

// ---------------------------------------------------------------------------
// handleCheckoutCompleted step helpers
// ---------------------------------------------------------------------------

async function isDuplicateWebhookOrder(sessionId: string): Promise<boolean> {
  const existingOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.stripeSessionId, sessionId))
    .limit(1);
  return existingOrder.length > 0;
}

async function loadWebhookEvent(eventId: string) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) {
    throw new Error(`Event not found: ${eventId}`);
  }
  return event;
}

async function resolveWebhookTicketTypes(cart: CartEntry[], eventId: string) {
  const allTypes = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId));
  const typesById = new Map(allTypes.map((t) => [t.id, t]));
  for (const item of cart) {
    if (!typesById.has(item.ticketTypeId)) {
      throw new Error(`Ticket type not found: ${item.ticketTypeId}`);
    }
  }
  return typesById;
}

/**
 * Resolve the ticket owner DID: reuse the hard DID when the buyer was logged
 * in at checkout time, otherwise create/resolve a soft DID from their email.
 */
async function resolveWebhookOwnerDid(
  buyerDid: string | undefined,
  customerEmail: string,
  customerName: string | null | undefined,
  eventId: string,
): Promise<string> {
  if (buyerDid) {
    log.info({ ownerDid: buyerDid }, 'Buyer authenticated with hard DID');
    await attachEmailToProfile(buyerDid, customerEmail);
    await backfillContactEmail(buyerDid, customerEmail, log);
    await migrateSoftDidToHard(customerEmail, buyerDid, eventId);
    return buyerDid;
  }

  const softSession = await createSoftDidSession(customerEmail, customerName || undefined);
  if (!softSession?.did) {
    throw new Error(`Failed to create soft DID session for ${customerEmail}`);
  }
  await backfillContactEmail(softSession.did, customerEmail, log);
  return softSession.did;
}

function publishWebhookTicketsPurchased(
  createdTickets: Array<{ id: string; pricePaid: number | null }>,
  event: { id: string; creatorDid: string },
  ownerDid: string,
  currency: string,
): void {
  for (const ticket of createdTickets) {
    bus.publish('ticket.purchased', {
      issuer: ownerDid, subject: event.creatorDid, scope: 'events',
      payload: {
        ticketId: ticket.id, eventId: event.id,
        amount: ticket.pricePaid ?? 0, currency,
        context_id: event.id, context_type: 'event',
        to: ownerDid,
        interestDids: [ownerDid],
      }
    }).catch((err) => log.error({ err: String(err), ticketId: ticket.id }, 'ticket.purchased publish error'));
  }
}

interface WebhookSettlementParams {
  ownerDid: string;
  event: { id: string; did: string; creatorDid: string; metadata: unknown };
  orderId: string;
  amountTotal: number;
  currency: string;
  createdTickets: Array<{ id: string }>;
  firstTypeId: string;
  sessionId: string;
  /** Kernel `transactionId` of the app-authenticated checkout, when the pay webhook carries it. */
  transactionId?: string;
}

/**
 * Settle a completed order (imajin-ai#2739): events calls the pay service's
 * `/api/settle` itself with its own app-service token. The kernel's bus
 * `settle` reactor only runs in the kernel process, so announcing the order
 * from here would not settle anything.
 * Non-fatal — settlement failures are logged, not thrown.
 */
async function triggerWebhookSettlement(params: WebhookSettlementParams): Promise<void> {
  const { ownerDid, event, orderId, amountTotal, currency, createdTickets, firstTypeId, sessionId, transactionId } = params;
  const eventMetadata = (event.metadata || {}) as { fair?: unknown };

  try {
    await settleCompletedOrder({
      sessionId,
      transactionId,
      orderId,
      eventId: event.id,
      buyerDid: ownerDid,
      creatorDid: event.creatorDid,
      amountCents: amountTotal,
      currency,
      fairManifest: eventMetadata.fair || null,
      metadata: {
        orderId,
        ticketIds: createdTickets.map((t) => t.id),
        ticketTypeId: firstTypeId,
        stripeSessionId: sessionId,
        eventId: event.id,
      },
      log,
    });
  } catch (settleError) {
    log.error({ err: String(settleError) }, '[settle] Unexpected settlement error (non-fatal)');
  }
}

interface WebhookRegistrationInfo {
  magicLink?: string;
  registrationUrl: string;
}

/**
 * Build the onboard magic link and registration/tickets destination URL used
 * in the confirmation email.
 */
async function resolveWebhookRegistrationInfo(
  createdTickets: Array<{ id: string; registrationStatus?: string | null }>,
  event: { id: string },
): Promise<WebhookRegistrationInfo> {
  const EVENTS_URL = buildPublicUrlAbsolute('events');
  const eventsAuthUrl = publicServiceUrl('auth');

  const ctaTicket = createdTickets.find((t) => t.registrationStatus === 'pending') ?? null;

  const onboardToken = await createOnboardToken();
  const magicLink = onboardToken ? `${eventsAuthUrl}/api/onboard/verify?token=${onboardToken}` : undefined;
  let registrationUrl = eventMyTicketsUrl(EVENTS_URL, event.id);
  if (ctaTicket) {
    registrationUrl = magicLink ?? eventRegisterUrl(EVENTS_URL, event.id, ctaTicket.id);
  }

  return { magicLink, registrationUrl };
}

interface PaymentWebhookPayload {
  type: 'checkout.completed' | 'payment.failed';
  sessionId: string;
  paymentId?: string;
  /** Kernel `transactionId` of the app-authenticated checkout — the key `/pay/api/settle` needs (imajin-ai#2739). */
  transactionId?: string;
  customerEmail: string;
  customerName?: string | null;
  amountTotal: number;
  currency: string;
  metadata: {
    eventId: string;
    eventDid: string;
    // Legacy single-type fields
    ticketTypeId?: string;
    quantity?: string;
    // Multi-type cart (JSON string)
    cart?: string;
    totalQuantity?: string;
    buyerDid?: string;
  };
}

export const POST = withLogger('events', async (request, { log }) => {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload: PaymentWebhookPayload = await request.json();

    log.info({ type: payload.type, sessionId: payload.sessionId }, 'Payment webhook received');

    if (payload.type === 'checkout.completed') {
      await handleCheckoutCompleted(payload);
    } else if (payload.type === 'payment.failed') {
      await handlePaymentFailed(payload);
    }

    return NextResponse.json({ received: true });

  } catch (error) {
    log.error({ err: String(error) }, 'Payment webhook error');
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
});

async function handleCheckoutCompleted(payload: PaymentWebhookPayload) {
  const { metadata, customerName, amountTotal, currency, sessionId, paymentId, transactionId } = payload;
  const customerEmail = payload.customerEmail || null;

  // Parse cart: multi-type (cart JSON) or legacy single-type
  const cart = parseCartFromMetadata(metadata);
  const totalQuantity = cart.reduce((sum, c) => sum + c.quantity, 0);

  // Idempotency: check if an order for this Stripe session already exists
  if (await isDuplicateWebhookOrder(sessionId)) {
    log.info({ sessionId }, 'Duplicate webhook — order already exists for session');
    return;
  }

  if (!customerEmail) {
    throw new Error('Customer email is required for ticket creation');
  }

  const event = await loadWebhookEvent(metadata.eventId);

  // Fetch all ticket types referenced in cart
  const typesById = await resolveWebhookTicketTypes(cart, metadata.eventId);
  // Use first type for backward-compat fields that need a single value
  const firstType = typesById.get(cart[0].ticketTypeId)!;

  // Resolve owner DID: use hard DID if buyer was logged in, otherwise create soft DID
  const ownerDid = await resolveWebhookOwnerDid(metadata.buyerDid, customerEmail, customerName, event.id);

  const { tickets: createdTickets, order } = await createOrderWithTickets({
    eventId: event.id,
    buyerDid: ownerDid,
    cart,
    typesById,
    totalQuantity,
    totalAmount: amountTotal,
    currency: currency.toUpperCase(),
    paymentMethod: paymentId ? 'stripe' : 'etransfer',
    ticketStatus: 'valid',
    stripeSessionId: sessionId,
    paymentId: paymentId || undefined,
    orderMetadata: {
      purchaseEmail: customerEmail,
      customerName: customerName || null,
      cart: cart.map(c => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity })),
    },
    ticketMetadata: {
      stripeSessionId: sessionId,
      purchaseEmail: customerEmail,
    },
    eventDid: event.did,
    eventPrivateKey: event.privateKey,
    customerEmail,
    log,
    incrementSold: true,
  });

  const orderId = order.id;

  // Per-ticket attestation: fire-and-forget so we never block the response.
  publishWebhookTicketsPurchased(createdTickets, event, ownerDid, currency);

  log.info({ count: createdTickets.length, orderId, customerEmail }, 'Order + tickets created');

  // Add buyer to event chat conversation_members (non-fatal). Event DID = conversation DID.
  const CHAT_URL = serviceUrl('chat');
  if (CHAT_URL) {
    await syncBuyerToEventChat(CHAT_URL, event.did, ownerDid, log);
  }

  // Settle through the pay service with events' own app token
  await triggerWebhookSettlement({
    ownerDid,
    event,
    orderId,
    amountTotal,
    currency,
    createdTickets,
    firstTypeId: firstType.id,
    sessionId,
    transactionId,
  });

  // Build onboard token for magic-link auth in confirmation email
  const { magicLink, registrationUrl } = await resolveWebhookRegistrationInfo(createdTickets, event);

  await publishConfirmationEmails({
    customerEmail,
    customerName,
    ownerDid,
    event,
    firstTypeName: firstType.name,
    createdTickets,
    currency,
    amountTotal,
    paymentId,
    magicLink,
    registrationUrl,
    log,
  });
}

async function handlePaymentFailed(payload: PaymentWebhookPayload) {
  const { metadata, customerEmail } = payload;

  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, metadata.eventId))
    .limit(1);

  if (!event) {
    log.error({ eventId: metadata.eventId }, 'Event not found for failed payment');
    return;
  }

  await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, metadata.ticketTypeId ?? ''))
    .limit(1);

  log.info({ customerEmail, eventTitle: event.title }, 'Payment failed');

  // Optionally send a "payment failed" email
  // For now, just log it - Stripe also sends their own failure emails
}
