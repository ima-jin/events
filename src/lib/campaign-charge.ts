import { and, eq, sql } from 'drizzle-orm';
import { db, pledges, type Pledge } from '@/db';
import { payForbiddenMessage, postPayAsApp } from './pay-app-request';

type ChargeOutcome =
  | { pledgeId: string; status: 'charged' }
  | { pledgeId: string; status: 'failed'; code: string };

interface ChargeBatch {
  charged: number;
  failed: number;
  total: number;
  results: ChargeOutcome[];
}

type ChargeFailure = { error: string; status: 403 | 503 };
const UNAVAILABLE: ChargeFailure = { error: 'Failed to charge pledges', status: 503 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function chargeReference(pledge: Pledge, creatorDid: string) {
  const metadata = isRecord(pledge.metadata) ? pledge.metadata : {};
  const sellerDid = metadata.sellerDid ?? creatorDid;
  if (typeof sellerDid !== 'string' || !sellerDid.startsWith('did:imajin:') ||
      typeof pledge.stripeSetupIntentId !== 'string' || !/^seti_[A-Za-z0-9]+$/.test(pledge.stripeSetupIntentId)) {
    throw new Error('Invalid recorded pledge binding');
  }
  return { pledgeId: pledge.id, setupIntentId: pledge.stripeSetupIntentId, sellerDid };
}

function parseOutcome(value: unknown): ChargeOutcome | null {
  if (!isRecord(value) || typeof value.pledgeId !== 'string') return null;
  if (value.status === 'charged') return { pledgeId: value.pledgeId, status: 'charged' };
  if (value.status === 'failed' && typeof value.code === 'string' &&
      /^[A-Za-z]\w{0,127}$/.test(value.code)) {
    return { pledgeId: value.pledgeId, status: 'failed', code: value.code };
  }
  return null;
}

/** Validate the whole batch before any mutation, and retain codes, never upstream error prose. */
function validatedBatch(data: unknown, requested: Pledge[]): ChargeBatch | null {
  if (!isRecord(data) || !Array.isArray(data.results)) return null;
  const remaining = new Set(requested.map((pledge) => pledge.id));
  const results: ChargeOutcome[] = [];
  for (const value of data.results) {
    const result = parseOutcome(value);
    if (!result || !remaining.delete(result.pledgeId)) return null;
    results.push(result);
  }
  if (remaining.size > 0) return null;
  const charged = results.filter((result) => result.status === 'charged').length;
  return { charged, failed: results.length - charged, total: results.length, results };
}

/** Shared transport owns the sole 401 retry; all ambiguous failures require reconciliation. */
export async function chargeCampaignPledges(eventId: string, creatorDid: string, confirmed: Pledge[]):
Promise<ChargeBatch | ChargeFailure> {
  try {
    const response = await postPayAsApp('/api/charge-pledges', {
      eventId,
      pledges: confirmed.map((pledge) => chargeReference(pledge, creatorDid)),
    });
    if (response.status === 403) {
      return { error: payForbiddenMessage('pay:charge-pledges'), status: 403 };
    }
    if (!response.ok) return UNAVAILABLE;
    return validatedBatch(await response.json(), confirmed) ?? UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** A concurrent replay cannot overwrite terminal state or a changed payment binding. */
export async function recordCampaignCharges(confirmed: Pledge[], results: ChargeOutcome[]): Promise<void> {
  const outcomes = new Map(results.map((result) => [result.pledgeId, result]));
  await Promise.all(confirmed.map((pledge) => {
    const result = outcomes.get(pledge.id);
    if (!result) throw new Error('Missing validated pledge outcome');
    const update = result.status === 'charged'
      ? { status: 'charged', chargedAt: new Date() }
      : { status: 'failed', failureReason: result.code };
    return db.update(pledges).set(update).where(and(
      eq(pledges.id, pledge.id),
      eq(pledges.eventId, pledge.eventId),
      eq(pledges.status, 'confirmed'),
      eq(pledges.backerDid, pledge.backerDid),
      eq(pledges.amount, pledge.amount),
      eq(pledges.currency, pledge.currency),
      sql`${pledges.stripeSetupIntentId} is not distinct from ${pledge.stripeSetupIntentId}`,
      sql`${pledges.stripeCustomerId} is not distinct from ${pledge.stripeCustomerId}`,
      sql`${pledges.stripePaymentMethodId} is not distinct from ${pledge.stripePaymentMethodId}`,
      sql`${pledges.metadata} is not distinct from ${pledge.metadata === null ? null : JSON.stringify(pledge.metadata)}::jsonb`,
    ));
  }));
}
