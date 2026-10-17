import { withBasePath } from '@/lib/base-path';
import { eventPayload, minorUnits, tierPayload } from './model';
import type { FormDetails, TierDraft } from './types';
import { organizerError } from '../organizer/request-error';

export interface SaveProgress {
  eventId?: string;
  tierIds: Map<string, string>;
  uncertain: boolean;
  status?: string;
}

const AMBIGUOUS = 'The save result is uncertain. Check the organizer dashboard before trying again; automatic retry is disabled to prevent duplicates.';

/** Only extract the ID; keys in the server event response never enter React state, storage, logs or errors. */
async function createdId(response: Response, field: 'event' | 'tier'): Promise<string> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !(field in body)) throw new Error(AMBIGUOUS);
  const record = (body as Record<string, unknown>)[field];
  if (typeof record !== 'object' || record === null || !('id' in record)) throw new Error(AMBIGUOUS);
  const id = record.id;
  if (typeof id !== 'string' || !id) throw new Error(AMBIGUOUS);
  return id;
}

async function writeRefusal(response: Response, path: string, method: string, progress: SaveProgress): Promise<never> {
  const data: unknown = await response.json().catch(() => null);
  const refusal = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
  const paymentRefusal = refusal.code === 'SELLER_NO_CARD_RAIL' || refusal.code === 'CARD_RAIL_UNAVAILABLE';
  const createdDraft = paymentRefusal && method === 'POST' && path === '/api/events';
  if (createdDraft && typeof refusal.eventId === 'string' && refusal.eventId) {
    progress.eventId = refusal.eventId;
    progress.status = 'draft';
  }
  // Validation/auth refusals have not performed a write. 5xx responses may have written already.
  const rejectedBeforeWrite = response.status >= 400 && response.status < 500 && !createdDraft;
  const confirmedPaymentRefusal = paymentRefusal && (method === 'PUT' || Boolean(progress.eventId));
  if (rejectedBeforeWrite || confirmedPaymentRefusal) {
    progress.uncertain = false;
  }
  throw organizerError(data);
}

async function write(path: string, method: 'POST' | 'PUT', body: object, progress: SaveProgress): Promise<Response> {
  if (method === 'POST') progress.uncertain = true;
  const response = await fetch(withBasePath(path), {
    method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) return writeRefusal(response, path, method, progress);
  return response;
}

async function saveTier(path: string, tier: TierDraft, index: number, progress: SaveProgress): Promise<void> {
  const id = tier.id || progress.tierIds.get(tier.key);
  const body = tierPayload(tier, index);
  if (id) {
    await write(`${path}/tiers`, 'PUT', { ...body, tierId: id }, progress);
  } else {
    const response = await write(`${path}/tiers`, 'POST', body, progress);
    progress.tierIds.set(tier.key, await createdId(response, 'tier'));
    progress.uncertain = false;
  }
}

async function saveFreeConversions(path: string, details: FormDetails, tiers: readonly TierDraft[], progress: SaveProgress): Promise<Set<string>> {
  const saved = new Set<string>();
  if (progress.status !== 'published' || details.emtEnabled || !tiers.every((tier) => minorUnits(tier.price) === 0)) return saved;
  // Keep the current payment rail until all persisted paid tiers are confirmed free.
  // Newly added free tiers can still be created after the details update.
  for (const [index, tier] of tiers.entries()) {
    if (tier.id || progress.tierIds.has(tier.key)) {
      await saveTier(path, tier, index, progress);
      saved.add(tier.key);
    }
  }
  return saved;
}

export async function saveForm(details: FormDetails, tiers: readonly TierDraft[], progress: SaveProgress): Promise<string> {
  if (progress.uncertain) throw new Error(AMBIGUOUS);
  const payload = eventPayload(details);
  if (!progress.eventId) {
    const response = await write('/api/events', 'POST', { ...payload, status: 'draft', eventType: 'event', tickets: [] }, progress);
    progress.eventId = await createdId(response, 'event');
    progress.uncertain = false;
    progress.status = 'draft';
  }
  const eventId = progress.eventId;
  const path = `/api/events/${encodeURIComponent(eventId)}`;
  const savedTiers = await saveFreeConversions(path, details, tiers, progress);
  // Never unpublish an existing live event just to edit it. Publication is the last write.
  const { status, ...detailsPayload } = payload;
  const updatePayload = status === 'published' ? detailsPayload : payload;
  await write(path, 'PUT', updatePayload, progress);
  if (status !== 'published') progress.status = status;
  // Serialize writes so a refusal stops the chain and confirmed IDs remain retryable.
  for (const [index, tier] of tiers.entries()) {
    if (!savedTiers.has(tier.key)) await saveTier(path, tier, index, progress);
  }
  if (status === 'published' && progress.status !== 'published') {
    await write(path, 'PUT', { status }, progress);
    progress.status = status;
  }
  return eventId;
}
