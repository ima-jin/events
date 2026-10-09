/**
 * Serialization guard for event rows returned over HTTP.
 *
 * `events.private_key` is the event's Ed25519 ticket-signing key. It is handed
 * to the creator exactly once, in the `POST /api/events` response, and must
 * never appear in any read response. The kernel version of the read routes
 * returned the whole row (including the key) to unauthenticated callers; this
 * port strips it (imajin-ai#2515 — a deliberate deviation from kernel parity).
 */
export function toPublicEvent<T extends { privateKey?: unknown }>(event: T): Omit<T, 'privateKey'> {
  const publicEvent = { ...event };
  delete publicEvent.privateKey;
  return publicEvent;
}

/** Fields safe to return to a legacy registered-app caller holding only the `events:read` scope. */
export function filterEventForApp(event: Record<string, unknown>): Record<string, unknown> {
  const {
    id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl,
    venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug,
    nameDisplayPolicy, chatEnabled, createdAt, updatedAt,
  } = event;
  return {
    id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl,
    venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug,
    nameDisplayPolicy, chatEnabled, createdAt, updatedAt,
  };
}
