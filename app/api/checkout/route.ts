import { serviceUrl } from '@/lib/kernel';
/**
 * POST /api/checkout
 *
 * Creates a checkout session via the pay service.
 * Events app doesn't touch Stripe directly â€” sovereign node model.
 */

import { NextResponse } from 'next/server';
import { withLogger, type Logger } from '@ima-jin/logger';
import { publish } from '@/lib/domain-events';
import { eventInvites, db } from '@/db';
import { eq } from 'drizzle-orm';
import { rateLimit, getClientIP, eventUrl } from '@ima-jin/config';
import {
  validateCart,
  resolveCheckoutIdentity,
  resolveInviteAccessForEvent,
  loadPublishedEvent,
  createSoftDidFromEmail,
  CheckoutValidationError,
  type EventMetadata,
} from '@/lib/checkout-common';
import { prepareAppCheckout } from '@/lib/pay-settle';
import {
  normalizeCheckoutCart,
  validateCheckoutCartLimits,
  buildStripeCheckoutItems,
  requestPayCheckoutSession,
} from '@/lib/checkout-helpers';

const PAY_SERVICE_URL = (serviceUrl('pay') ?? '');
const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL!;

interface CheckoutRequest {
  eventId: string;
  // Multi-type cart
  items?: Array<{ ticketTypeId: string; quantity: number }>;
  // Legacy single-type (still accepted)
  ticketTypeId?: string;
  quantity?: number;
  email?: string;
  invite?: string;
}

/** 429 response when the caller's IP exceeded the checkout rate limit, otherwise null. */
function rateLimitedResponse(request: Request): NextResponse | null {
  const rl = rateLimit(getClientIP(request), 10, 60_000);
  if (!rl.limited) return null;
  return NextResponse.json(
    { error: 'Too many requests', retryAfter: rl.retryAfter },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
  );
}

/** Response for a pay-service failure, carrying the machine-readable `code` (e.g. SELLER_NO_CARD_RAIL) when present. */
function payFailureResponse(failure: { error: string; status: number; code?: string }): NextResponse {
  const body = failure.code ? { error: failure.error, code: failure.code } : { error: failure.error };
  return NextResponse.json(body, { status: failure.status });
}

/** Count one use of the invite that gated this checkout, if any. */
async function consumeInvite(invite: { id: string; usedCount: number } | null | undefined): Promise<void> {
  if (!invite) return;
  await db
    .update(eventInvites)
    .set({ usedCount: invite.usedCount + 1 })
    .where(eq(eventInvites.id, invite.id));
}

/** Map a thrown checkout failure to its response: validation errors keep their status, anything else is a logged 500. */
function checkoutErrorResponse(error: unknown, log: Logger): NextResponse {
  if (error instanceof CheckoutValidationError) {
    return NextResponse.json(
      { error: error.message, ...(error.field ? { field: error.field } : {}) },
      { status: error.statusCode },
    );
  }
  log.error({ err: String(error) }, 'Checkout error');
  return NextResponse.json({ error: 'Checkout failed' }, { status: 500 });
}

export const POST = withLogger('events', async (request, { log, correlationId }) => {
  const limited = rateLimitedResponse(request);
  if (limited) return limited;

  try {
    const body: CheckoutRequest = await request.json();

    if (!body.eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400 });
    }

    // Normalize to cart: accept items[] or legacy ticketTypeId+quantity
    const cartResult = normalizeCheckoutCart(body);
    if (!Array.isArray(cartResult)) {
      return NextResponse.json({ error: cartResult.error }, { status: cartResult.status });
    }
    const cart = cartResult;

    // Fetch event + status check up-front so invite check (which needs
    // accessMode) can run before per-type validation.
    const eventResult = await loadPublishedEvent(body.eventId);
    if ('error' in eventResult) {
      return NextResponse.json({ error: eventResult.error }, { status: eventResult.status });
    }
    const { event } = eventResult;

    // Invite-only access check
    const inviteToken = body.invite || request.nextUrl.searchParams.get('invite');
    const inviteRecord = await resolveInviteAccessForEvent(event, inviteToken);

    // validateCart: type existence + currency consistency. Max-per-order
    // and availability are checked inline below so error messages keep the
    // type-name prefix the route surfaced before this refactor.
    const eventMeta = (event.metadata || {}) as EventMetadata;
    const { typesById, totalQuantity, currency: cartCurrency } = await validateCart(
      body.eventId,
      cart,
    );

    const cartError = validateCheckoutCartLimits(cart, typesById, eventMeta);
    if (cartError) return cartError;

    const identity = await resolveCheckoutIdentity(request, { email: body.email }, log);
    // Stripe only attributes purchases to hard-tier sessions; soft sessions
    // get no buyerDid (Stripe collects email instead).
    const buyerDid = identity.did;
    const customerEmail = identity.email;

    const fairManifest = eventMeta.fair || null;
    const stripeItems = buildStripeCheckoutItems(cart, typesById, event.title);

    // Authenticate this checkout as the events app and declare the payee manifest, so the payment
    // is bound to events and events can settle it itself on order completion (imajin-ai#2739).
    const appCheckout = await prepareAppCheckout({
      fairManifest,
      amountCents: stripeItems.reduce((sum, item) => sum + item.amount * item.quantity, 0),
      buyerDid,
      email: customerEmail,
      resolveSoftDid: createSoftDidFromEmail,
      log,
    });
    if ('error' in appCheckout) {
      return NextResponse.json({ error: appCheckout.error }, { status: appCheckout.status });
    }

    const payResult = await requestPayCheckoutSession({
      payServiceUrl: PAY_SERVICE_URL,
      items: stripeItems,
      currency: cartCurrency,
      customerEmail,
      successUrl: `${EVENTS_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&event=${event.id}`,
      cancelUrl: eventUrl(EVENTS_URL, event.id),
      fairManifest,
      sellerDid: event.creatorDid,
      appAuth: appCheckout.appAuth,
      metadata: {
        service: 'events',
        eventId: event.id,
        eventDid: event.did,
        cart: JSON.stringify(cart.map((c) => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity }))),
        totalQuantity: String(totalQuantity),
        ...(buyerDid && { buyerDid }),
      },
      log,
    });

    if ('error' in payResult) return payFailureResponse(payResult);
    const { checkout } = payResult;

    publish('ticket.purchase', {
      issuer: buyerDid || '',
      subject: event.creatorDid,
      scope: 'events',
      payload: {
        eventId: body.eventId,
        cart: cart.map((c) => ({ ticketTypeId: c.ticketTypeId, quantity: c.quantity })),
        totalQuantity,
        sellerDid: event.creatorDid,
      },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    await consumeInvite(inviteRecord);

    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
    });

  } catch (error) {
    return checkoutErrorResponse(error, log);
  }
});
