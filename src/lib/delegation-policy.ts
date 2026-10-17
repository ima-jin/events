import { evaluateDelegationPolicy, type DelegationDecision, type DelegationSource, type MutationClass } from '@ima-jin/auth/delegation-policy';

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface RoutePolicy {
  method: Method;
  path: string;
  action: string;
  class: MutationClass;
  why: string;
}

/** App-owned inventory, not the SDK's historical kernel route registry (#60 / #2360). */
export const DELEGATION_ROUTES = {
  'events.campaign.cancel': { method: 'POST', path: '/api/campaign/[eventId]/cancel', action: 'cancel', class: 'irreversible', why: 'Cancels a funding campaign.' },
  'events.campaign.settle': { method: 'POST', path: '/api/campaign/[eventId]/settle', action: 'settle', class: 'value-moving', why: 'Charges confirmed pledges.' },
  'events.campaign.pledge': { method: 'POST', path: '/api/campaign/pledge', action: 'pledge', class: 'reversible', why: 'SetupIntent proposal; the owner still authorizes the card in Stripe.' },
  'events.campaign.pledge-confirm': { method: 'POST', path: '/api/campaign/pledge/confirm', action: 'pledge-confirm', class: 'reversible', why: 'Verifies the SetupIntent already authorized by the owner.' },
  'events.checkout.balance': { method: 'POST', path: '/api/checkout/balance', action: 'balance', class: 'value-moving', why: 'Transfers the buyer balance.' },
  'events.event.fair-update': { method: 'PATCH', path: '/api/events/[id]/fair', action: 'fair-update', class: 'value-moving', why: 'Rewrites attribution and settlement splits.' },
  'events.event.cohost-add': { method: 'POST', path: '/api/events/[id]/cohosts', action: 'cohost-add', class: 'value-moving', why: 'Adds a cohost and attribution share.' },
  'events.ticket.cancel': { method: 'POST', path: '/api/events/[id]/tickets/[ticketId]/cancel', action: 'cancel', class: 'irreversible', why: 'Cancels an issued ticket.' },
  'events.ticket.refund': { method: 'POST', path: '/api/events/[id]/tickets/[ticketId]/refund', action: 'refund', class: 'value-moving', why: 'Refunds a ticket.' },
  'events.ticket.mark-refund-sent': { method: 'POST', path: '/api/events/[id]/tickets/[ticketId]/mark-refund-sent', action: 'mark-refund-sent', class: 'value-moving', why: 'Records an off-platform refund.' },
  'events.ticket.confirm-payment': { method: 'POST', path: '/api/tickets/[id]/confirm-payment', action: 'confirm-payment', class: 'value-moving', why: 'Confirms payment and issues a ticket.' },
  'events.order.confirm-payment': { method: 'POST', path: '/api/orders/[id]/confirm-payment', action: 'confirm-payment', class: 'value-moving', why: 'Confirms an e-transfer order.' },
  'events.order.refund': { method: 'POST', path: '/api/orders/[id]/refund', action: 'refund', class: 'value-moving', why: 'Refunds an order.' },
  'events.event.create': { method: 'POST', path: '/api/events', action: 'create', class: 'irreversible', why: 'Registers an event DID and discloses its signing key; no delete route.' },
  'events.event.update': { method: 'PUT', path: '/api/events/[id]', action: 'update', class: 'reversible', why: 'Editable event details; sensitive fields are escalated below.' },
  'events.event.status': { method: 'PATCH', path: '/api/events/[id]', action: 'status', class: 'irreversible', why: 'Publishes or cancels an event.' },
  'events.event.cohost-remove': { method: 'DELETE', path: '/api/events/[id]/cohosts', action: 'cohost-remove', class: 'value-moving', why: 'Changes organizer authority and attribution.' },
  'events.event.message': { method: 'POST', path: '/api/events/[id]/message', action: 'message', class: 'irreversible', why: 'Broadcasts cannot be unsent.' },
  'events.event.invite': { method: 'POST', path: '/api/events/[id]/invites', action: 'invite', class: 'irreversible', why: 'Discloses invite-only access.' },
  'events.event.invite-delete': { method: 'DELETE', path: '/api/events/[id]/invites/[inviteId]', action: 'invite-delete', class: 'irreversible', why: 'Revokes an issued invitation.' },
  'events.ticket.check-in': { method: 'POST', path: '/api/events/[id]/tickets/[ticketId]/check-in', action: 'check-in', class: 'irreversible', why: 'Consumes admission; no undo route.' },
  'events.ticket.resend-email': { method: 'POST', path: '/api/events/[id]/tickets/[ticketId]/resend-email', action: 'resend-email', class: 'irreversible', why: 'Sends a bearer ticket by email.' },
  'events.event.tier-create': { method: 'POST', path: '/api/events/[id]/tiers', action: 'tier-create', class: 'irreversible', why: 'Append-only ticket offer creation; no delete route.' },
  'events.event.tier-update': { method: 'PUT', path: '/api/events/[id]/tiers', action: 'tier-update', class: 'irreversible', why: 'Sold-tier price reductions and perk additions cannot be undone.' },
  'events.event.hold': { method: 'POST', path: '/api/events/[id]/hold', action: 'hold', class: 'reversible', why: 'Expiring ticket reservation.' },
  'events.event.hold-release': { method: 'DELETE', path: '/api/events/[id]/hold', action: 'hold-release', class: 'reversible', why: 'Releases a temporary reservation.' },
  'events.event.queue': { method: 'POST', path: '/api/events/[id]/queue', action: 'queue', class: 'reversible', why: 'Join a waitlist.' },
  'events.event.queue-leave': { method: 'DELETE', path: '/api/events/[id]/queue', action: 'queue-leave', class: 'reversible', why: 'Leave a waitlist.' },
  'events.checkout.stripe': { method: 'POST', path: '/api/checkout', action: 'checkout', class: 'reversible', why: 'Hosted checkout proposal; the payer still pays in Stripe.' },
  'events.checkout.etransfer': { method: 'POST', path: '/api/checkout/etransfer', action: 'etransfer', class: 'reversible', why: 'Pending order; the payer still sends money and organizer confirms.' },
  'events.checkout.free': { method: 'POST', path: '/api/checkout/free', action: 'rsvp', class: 'reversible', why: 'Public free RSVP; no delegated organizer value is moved.' },
} as const satisfies Record<string, RoutePolicy>;

/** Separate protocols, never delegated owner execution. Keep exceptions narrow and explicit. */
export const DELEGATION_EXCEPTIONS = [
  { method: 'POST', path: '/api/webhook/payment', why: 'Kernel-signed callback with audience and replay verification.' },
  { method: 'POST', path: '/api/webhook/settlement', why: 'Kernel-signed settlement callback, not session authority.' },
  { method: 'POST', path: '/api/claim', why: 'One-time app bootstrap claim code, not owner session authority.' },
  { method: 'POST', path: '/api/auth/logout', why: 'SDK session logout, no organizer resource mutation.' },
  { method: 'POST', path: '/api/migrate-tickets', why: 'Soak-gated registered-app migration protocol; does not consume actingFor.' },
  { method: 'POST', path: '/api/register/[ticketId]', why: 'Public survey-completion protocol, not organizer session authority.' },
  { method: 'POST', path: '/api/upload', why: 'Public image upload, no delegated owner resource authority.' },
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[')) {
      if (!actual[index]) return null;
      params[segment.slice(1, -1)] = actual[index];
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return params;
}

function requestPath(request: Request): string {
  const path = new URL(request.url).pathname;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

/** PUT also accepts fields that bypass dedicated money/disclosure routes. */
async function updateMutation(request: Request): Promise<{ action: string; class: MutationClass } | null> {
  let body: Record<string, unknown> | null;
  try {
    body = await request.clone().json();
  } catch {
    return null; // The handler retains its existing malformed-body behavior.
  }
  if (!body || typeof body !== 'object') return null;
  if ('metadata' in body || 'emtEmail' in body) return { action: 'fair-update', class: 'value-moving' };
  if ('status' in body || 'accessMode' in body) return { action: 'status', class: 'irreversible' };
  return null;
}

/**
 * Called at the common auth boundary, BEFORE resolving actingFor to an owner DID.
 * All policy decisions and proposal fields come from the published SDK.
 */
export async function evaluateEventsDelegationPolicy(request: Request, source: DelegationSource): Promise<DelegationDecision> {
  if (SAFE_METHODS.has(request.method)) return { allowed: true };
  const path = requestPath(request);
  for (const [key, entry] of Object.entries(DELEGATION_ROUTES)) {
    if (entry.method !== request.method) continue;
    const params = matchPath(entry.path, path);
    if (!params) continue;
    const sensitive = key === 'events.event.update' ? await updateMutation(request) : null;
    return evaluateDelegationPolicy(source, {
      action: sensitive?.action ?? entry.action,
      class: sensitive?.class ?? entry.class,
      resourceId: params.ticketId ?? params.inviteId ?? params.id ?? params.eventId,
    });
  }
  // Missing inventory must never silently authorize a new delegated mutation.
  return evaluateDelegationPolicy(source, { action: 'unclassified-mutation', class: 'irreversible' });
}
