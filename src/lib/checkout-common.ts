import { serviceUrl, backfillContactEmail as backfillKernelContactEmail } from '@/lib/kernel';
/**
 * Shared checkout logic for Stripe checkout, E-Transfer checkout, and payment webhook.
 *
 * Cart validation and order/ticket creation live in the service layer
 * (`@/services/orders-service`); this module keeps the request-facing pieces
 * (identity, invite access, published-event lookup) and re-exports the service
 * API so existing checkout routes keep their imports.
 *
 * Used by:
 * - app/api/checkout/route.ts          (Stripe checkout)
 * - app/api/checkout/etransfer/route.ts (E-Transfer checkout)
 * - app/api/webhook/payment/route.ts    (Stripe payment webhook)
 */

import { NextRequest } from 'next/server';
import { db, eventInvites, events } from '@/db';
import { eq, and } from 'drizzle-orm';
import { optionalAuth } from '@/lib/auth';
import { getContactEmail, backfillContactEmail } from '@/lib/contact-email';
import { isServiceError } from '@/services/errors';
import {
  validateCart as validateCartInService,
  type CartItem,
  type ValidateCartOptions,
  type ValidatedCart,
} from '@/services/orders-service';
import type { Logger } from '@ima-jin/logger';
import type { EventInvite, Event } from '@/db/schema';

export { createOrderWithTickets } from '@/services/orders-service';
export type {
  CartItem,
  EventMetadata,
  ValidateCartOptions,
  ValidatedCart,
  CreateOrderWithTicketsParams,
  CreateOrderWithTicketsResult,
} from '@/services/orders-service';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CheckoutValidationError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public field?: string,
  ) {
    super(message);
    this.name = 'CheckoutValidationError';
  }
}

// ---------------------------------------------------------------------------
// validateCart
// ---------------------------------------------------------------------------

/**
 * Fetch ticket types for an event, validate cart items, and compute totals
 * (see `validateCart` in `@/services/orders-service`). Service failures are
 * surfaced as `CheckoutValidationError` so checkout routes answer exactly as
 * before.
 */
export async function validateCart(
  eventId: string,
  items: CartItem[],
  options: ValidateCartOptions = {},
): Promise<ValidatedCart> {
  try {
    return await validateCartInService(eventId, items, options);
  } catch (error) {
    if (isServiceError(error)) {
      throw new CheckoutValidationError(error.message, error.status);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// validateInviteAccess
// ---------------------------------------------------------------------------

/**
 * Validate an invite token for an invite-only event.
 *
 * Throws CheckoutValidationError on any check failure.
 * Returns the invite record on success so the caller can increment usedCount.
 */
export async function validateInviteAccess(
  eventId: string,
  token: string | undefined | null,
): Promise<EventInvite> {
  if (!token) {
    throw new CheckoutValidationError(
      'This event requires an invite link',
      403,
    );
  }

  const [invite] = await db
    .select()
    .from(eventInvites)
    .where(and(eq(eventInvites.eventId, eventId), eq(eventInvites.token, token)))
    .limit(1);

  if (!invite) {
    throw new CheckoutValidationError('Invalid invite token', 403);
  }

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    throw new CheckoutValidationError(
      'This invite link has expired',
      403,
    );
  }

  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
    throw new CheckoutValidationError(
      'This invite link has reached its maximum uses',
      403,
    );
  }

  return invite;
}

// ---------------------------------------------------------------------------
// loadPublishedEvent
// ---------------------------------------------------------------------------

export type LoadPublishedEventResult =
  | { event: Event }
  | { error: string; status: number };

/**
 * Fetch an event and confirm it accepts checkouts (exists + status is
 * 'published'). Shared by all checkout routes so the not-found/not-published
 * checks stay consistent. `notPublishedMessage` lets callers keep their
 * existing copy for the "not published" case.
 */
export async function loadPublishedEvent(
  eventId: string,
  notPublishedMessage: string = 'Tickets are not available for this event',
): Promise<LoadPublishedEventResult> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);

  if (!event) {
    return { error: 'Event not found', status: 404 };
  }
  if (event.status !== 'published') {
    return { error: notPublishedMessage, status: 400 };
  }

  return { event };
}

// ---------------------------------------------------------------------------
// syncBuyerToEventChatFireAndForget
// ---------------------------------------------------------------------------

/**
 * Add the buyer to the event chat conversation as a member, fire-and-forget.
 * No-op when chat isn't configured. Shared by the balance and free checkout
 * routes.
 */
export function syncBuyerToEventChatFireAndForget(eventDid: string, buyerDid: string, log: Logger): void {
  const chatUrl = serviceUrl('chat');
  if (!chatUrl) return;

  fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberDid: buyerDid, role: 'member' }),
  }).catch((err) => log.warn({ err: String(err) }, 'Event chat member sync failed (non-fatal)'));
}

// ---------------------------------------------------------------------------
// resolveInviteAccessForEvent
// ---------------------------------------------------------------------------

/**
 * Run the invite-only access check for an event when it requires one.
 * No-op (returns undefined) for events that aren't invite-only.
 */
export async function resolveInviteAccessForEvent(
  event: { id: string; accessMode: string },
  token: string | undefined | null,
): Promise<EventInvite | undefined> {
  if (event.accessMode !== 'invite_only') {
    return undefined;
  }
  return validateInviteAccess(event.id, token);
}

// ---------------------------------------------------------------------------
// resolveCheckoutIdentity
// ---------------------------------------------------------------------------

/**
 * Resolve the buyer's identity for checkout. Canonical for ALL checkout paths
 * (Stripe, e-Transfer, free RSVP). Do not re-implement identity resolution in
 * a checkout route — extend this with an option instead.
 *
 * 1. Attempt session auth (optionalAuth).
 * 2. If authenticated: backfill contact email if provided, resolve the stored
 *    contact email, return DID + resolved email.
 * 3. If not authenticated:
 *    - default: return just the email (caller defers DID creation — Stripe
 *      hands the email to the pay service; e-Transfer sends a magic-link).
 *    - `createSoftDid: true`: eagerly create/resolve a soft DID from the email
 *      (free RSVP needs a ticket owner immediately — there is no later step to
 *      defer to). Requires `email`.
 *
 * `opts.name` is used only when minting a soft DID.
 */
export async function resolveCheckoutIdentity(
  request: NextRequest,
  body: { email?: string; name?: string },
  log: Logger,
  opts?: { createSoftDid?: boolean },
): Promise<{ did?: string; email?: string }> {
  const session = await optionalAuth(request);

  if (session) {
    const did = session.id;
    let email = body.email;

    if (email) {
      await backfillContactEmail(did, email, log);
      // Soft-DID/free flows also rely on profile.profiles.contact_email for
      // ticket delivery; keep both stores aligned for authenticated buyers.
      await backfillProfileContactEmail(did, email, log);
    }

    const contactEmail = await getContactEmail(did, log);
    if (!email && contactEmail) {
      email = contactEmail;
    }

    return { did, email };
  }

  if (opts?.createSoftDid) {
    if (!body.email) {
      throw new Error('email is required to create a soft DID for checkout');
    }
    const did = await createSoftDidFromEmail(body.email, body.name);
    await backfillProfileContactEmail(did, body.email, log);
    return { did, email: body.email };
  }

  return { email: body.email };
}

/**
 * Create or retrieve a soft DID from an email via the auth service.
 * Canonical for checkout soft-DID minting.
 */
export async function createSoftDidFromEmail(email: string, name?: string): Promise<string> {
  const authUrl = (serviceUrl('auth') ?? '') || process.env.NEXT_PUBLIC_AUTH_URL;
  const response = await fetch(`${authUrl}/api/session/soft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.toLowerCase().trim(), name: name?.trim() }),
  });
  if (!response.ok) {
    throw new Error(`Soft DID creation failed: ${response.status}`);
  }
  const data = await response.json();
  return data.did;
}

/**
 * Backfill the DID's contact email via the kernel (NULL-guarded server-side).
 * This app never writes `profile.profiles` / `auth.identities` directly.
 */
async function backfillProfileContactEmail(did: string, email: string, log: Logger): Promise<void> {
  const ok = await backfillKernelContactEmail(did, email);
  if (!ok) {
    log.warn({ did }, 'backfillProfileContactEmail: kernel refused or unreachable (non-fatal)');
  }
}
