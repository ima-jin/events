/**
 * Customer notification for a refunded ticket: resolve who to tell and publish
 * `ticket.refunded` (the kernel reactors deliver the actual e-mail). Always
 * non-fatal — a failed notification never fails the refund.
 */
import { eventUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import { createLogger } from '@ima-jin/logger';
import type { Event } from '@/db/schema';
import { publish } from '@/lib/domain-events';
import { getContactEmail as resolveEmailForDid } from '@/lib/kernel';
import { getSurveyResponseForTicket } from '@/lib/ticket-survey';
import type { RefundableTicket } from '@/repositories/tickets-repository';

const log = createLogger('events');

export interface RefundNotificationInput {
  /** The organizer issuing the refund. */
  did: string;
  event: Pick<Event, 'id' | 'title' | 'imageUrl'>;
  ticket: RefundableTicket;
  isStripe: boolean;
  pricePaid: number;
  manualRefundRequired: boolean;
  priceDollars: string;
  currency: string;
}

/** Resolve the customer's notification email: survey response takes precedence over the owner DID lookup. */
async function resolveRefundCustomerEmail(
  ticketId: string,
  ownerDid: string | null,
): Promise<string | null> {
  const surveyResponse = await getSurveyResponseForTicket(ticketId);

  if (surveyResponse?.answers?.email) {
    return surveyResponse.answers.email;
  }
  if (ownerDid) {
    // #1998: resolveEmailForDid calls the profile service's batched
    // /api/resolve route (auth.credentials -> profile.profiles ->
    // auth.identities precedence).
    return resolveEmailForDid(ownerDid);
  }
  return null;
}

export function buildRefundMessage(
  eventTitle: string,
  isStripe: boolean,
  pricePaid: number,
  manualRefundRequired: boolean,
  priceDollars: string,
  currency: string,
): string {
  if (isStripe && pricePaid > 0) {
    return (
      `Your ticket for **${eventTitle}** has been refunded.\n\n` +
      `**Amount:** $${priceDollars} ${currency}\n\n` +
      `The refund has been processed and should appear on your card within 5–10 business days.`
    );
  }
  if (manualRefundRequired) {
    return (
      `Your refund for **${eventTitle}** is pending.\n\n` +
      `**Amount:** $${priceDollars} ${currency}\n\n` +
      `The organizer will send your refund via e-transfer. Please allow a few business days for processing.`
    );
  }
  return `Your ticket for **${eventTitle}** has been cancelled and refunded.`;
}

/** Publish the refund notification event for the customer (fire-and-forget, non-fatal). */
function publishRefundNotification(input: RefundNotificationInput, customerEmail: string): void {
  const { did, event, ticket, isStripe, pricePaid, manualRefundRequired, priceDollars, currency } =
    input;
  const refundMessage = buildRefundMessage(
    event.title,
    isStripe,
    pricePaid,
    manualRefundRequired,
    priceDollars,
    currency,
  );

  const eventsUrl = buildPublicUrlAbsolute('events');
  let imageUrl: string | null = null;
  if (event.imageUrl) {
    imageUrl = event.imageUrl.startsWith('http') ? event.imageUrl : `${eventsUrl}${event.imageUrl}`;
  }

  publish('ticket.refunded', {
    issuer: did,
    subject: ticket.owner_did || '',
    scope: 'events',
    payload: {
      email: customerEmail,
      refundMessage,
      eventTitle: event.title,
      eventImageUrl: imageUrl,
      eventUrl: eventUrl(eventsUrl, event.id),
      manualRefundRequired,
      context_id: event.id,
      context_type: 'event',
    },
  }).catch((err) =>
    log.error({ err: String(err) }, '[refund] Failed to publish ticket refunded event'),
  );
}

/**
 * Resolve the customer email and, if found, publish the refund notification.
 * Returns the email that was resolved (null when none, or on any failure).
 */
export async function notifyRefundCustomer(
  input: RefundNotificationInput,
): Promise<string | null> {
  try {
    const customerEmail = await resolveRefundCustomerEmail(input.ticket.id, input.ticket.owner_did);
    if (customerEmail) {
      publishRefundNotification(input, customerEmail);
    }
    return customerEmail;
  } catch (emailErr) {
    log.error({ err: String(emailErr) }, '[refund] Failed to publish refund event (non-fatal)');
    return null;
  }
}
