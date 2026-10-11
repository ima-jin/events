import { getSession, type SessionUser } from '@ima-jin/auth-client';
import { authConfig } from '@/lib/auth-config';
import { toPublicEventView, visibleTiers, type PublicEventView, type PublicTier } from '@/lib/public-event';
import { getEventWithTicketTypes } from '@/services/events-service';
import { isServiceError } from '@/services/errors';

export interface LoadedPublicEvent {
  event: PublicEventView;
  tiers: PublicTier[];
  hasHiddenTiers: boolean;
  /** Server-side only (never passed to a client component): who may see a draft/paused event. */
  creatorDid: string;
}

/**
 * One event + its publicly visible tiers, read through the events service
 * (never the DB directly). Everything is projected through the allow-listed
 * view models, so `privateKey`, the e-Transfer address and tier access codes
 * cannot reach a component. `null` when the event doesn't exist.
 */
export async function loadPublicEvent(eventId: string): Promise<LoadedPublicEvent | null> {
  try {
    const { event, ticketTypes } = await getEventWithTicketTypes(eventId, 'public');
    const { tiers, hasHiddenTiers } = visibleTiers(ticketTypes);
    return { event: toPublicEventView(event), tiers, hasHiddenTiers, creatorDid: String(event.creatorDid) };
  } catch (error) {
    if (isServiceError(error) && error.code === 'not_found') return null;
    throw error;
  }
}

/** The signed-in viewer, or `null` for anonymous visitors (and when no session can be read). */
export async function getViewer(): Promise<SessionUser | null> {
  try {
    return await getSession(authConfig);
  } catch {
    return null;
  }
}
