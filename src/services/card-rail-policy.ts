import { getCardRailReadiness } from '@/lib/card-rail';
import { ServiceError } from '@/services/errors';

/** Option A: free tickets and an explicitly configured e-Transfer rail do not require cards. */
export function requiresCardRail(hasPaidTiers: boolean, emtEmail: string | null | undefined): boolean {
  return hasPaidTiers && !emtEmail?.trim();
}

export async function requirePaidEventRail(
  event: { id: string; creatorDid: string; emtEmail?: string | null },
  hasPaidTiers: boolean,
): Promise<void> {
  if (!requiresCardRail(hasPaidTiers, event.emtEmail)) return;
  const readiness = await getCardRailReadiness(event.creatorDid);
  const details = { setupUrl: readiness.setupUrl, eventId: event.id };
  if (readiness.cardEnabled === null) {
    throw new ServiceError('unavailable', 'Payment readiness is unavailable. Please retry before publishing paid tickets.', {
      details: { ...details, code: 'CARD_RAIL_UNAVAILABLE', retryable: true },
    });
  }
  if (!readiness.cardEnabled) {
    throw new ServiceError('conflict', 'Connect Stripe or enable e-Transfer before publishing paid tickets.', {
      details: { ...details, code: 'SELLER_NO_CARD_RAIL' },
    });
  }
}
