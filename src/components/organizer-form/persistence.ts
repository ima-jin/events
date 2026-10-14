import { withBasePath } from '@/lib/base-path';
import { eventPayload, tierPayload } from './model';
import type { FormDetails, TierDraft } from './types';

export interface SaveProgress {
  eventId?: string;
  tierIds: Map<string, string>;
  uncertain: boolean;
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

async function write(path: string, method: 'POST' | 'PUT', body: object, progress: SaveProgress): Promise<Response> {
  if (method === 'POST') progress.uncertain = true;
  const response = await fetch(withBasePath(path), {
    method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Validation/auth refusals have not performed a write. 5xx responses may have written already.
    if (response.status >= 400 && response.status < 500) progress.uncertain = false;
    throw new Error('Unable to save. Check your permissions and fields, then retry.');
  }
  return response;
}

export async function saveForm(details: FormDetails, tiers: readonly TierDraft[], progress: SaveProgress): Promise<string> {
  if (progress.uncertain) throw new Error(AMBIGUOUS);
  const payload = eventPayload(details);
  if (!progress.eventId) {
    const response = await write('/api/events', 'POST', { ...payload, eventType: 'event', tickets: [] }, progress);
    progress.eventId = await createdId(response, 'event');
    progress.uncertain = false;
  }
  const eventId = progress.eventId;
  const path = `/api/events/${encodeURIComponent(eventId)}`;
  // Create does not accept accessMode/status. Apply them using the existing update contract.
  // Omitting metadata/chat/name policy leaves out-of-scope settings untouched.
  await write(path, 'PUT', payload, progress);
  for (const [index, tier] of tiers.entries()) {
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
  return eventId;
}
