import { isEventOrganizer as isOrganizer, type OrganizerCheck } from '@/services/authorization';

/**
 * Route-layer adapter over `services/authorization`: pass the incoming `request`
 * so the caller's own session cookie is forwarded to the kernel's pod-membership
 * route (see `isPodMember`).
 */
export function isEventOrganizer(eventId: string, did: string, request?: Request): Promise<OrganizerCheck> {
  return isOrganizer(eventId, did, request?.headers.get('cookie'));
}
