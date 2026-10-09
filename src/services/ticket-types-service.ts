import { randomBytes } from 'node:crypto';
import { buildTierUpdates, type TierUpdateBody } from '@/lib/tiers-helpers';
import {
  getTicketTypeForEvent,
  insertTicketType,
  listPublicTicketTypes,
  listTicketTypeCurrencies,
  listTicketTypesByAccessCode,
  updateTicketType,
  type TicketTypeRow,
} from '@/repositories/ticket-types-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';

/** Fallback for an event that has no tiers yet. */
const FALLBACK_CURRENCY = 'CAD';

export type TierWithAvailability = TicketTypeRow & { available: number | null };

export interface CreateTierBody {
  name?: string;
  description?: string | null;
  price?: number;
  currency?: string;
  quantity?: number | null;
  perks?: string[];
  sortOrder?: number;
  requiresRegistration?: boolean;
  registrationFormId?: string | null;
  accessCode?: string | null;
}

export interface UpdateTierBody extends TierUpdateBody {
  tierId?: string;
}

/**
 * Who is acting, on which event, and how to read the request body. The body is
 * read lazily so that the organizer check keeps running before the body is
 * parsed (a non-organizer with a malformed body still gets "Not authorized").
 */
export interface TierWriteInput<B> {
  eventId: string;
  actorDid: string;
  /** The caller's own session cookie, forwarded for co-host (pod membership) checks. */
  callerCookie?: string | null;
  readBody: () => Promise<B>;
}

export interface UpdateTierResult {
  tier: TicketTypeRow | TierWithAvailability;
  /** False when the request changed nothing (nothing was written). */
  changed: boolean;
}

function withAvailability(tier: TicketTypeRow): TierWithAvailability {
  return { ...tier, available: tier.quantity === null ? null : tier.quantity - (tier.sold || 0) };
}

async function requireOrganizer(eventId: string, actorDid: string, callerCookie?: string | null): Promise<void> {
  const check = await isEventOrganizer(eventId, actorDid, callerCookie);
  if (!check.authorized) {
    throw new ServiceError('forbidden', 'Not authorized');
  }
}

/** Public tiers of an event (access-code tiers excluded) with remaining availability. */
export async function listPublicTiers(eventId: string): Promise<TierWithAvailability[]> {
  const tiers = await listPublicTicketTypes(eventId);
  return tiers.map(withAvailability);
}

/** Tiers revealed by an access code (case-insensitive, no authentication). */
export async function unlockTiers(eventId: string, code: string | null | undefined): Promise<TierWithAvailability[]> {
  const trimmed = code?.trim();
  if (!trimmed) {
    throw new ServiceError('invalid', 'Missing code parameter');
  }
  const tiers = await listTicketTypesByAccessCode(eventId, trimmed);
  if (tiers.length === 0) {
    throw new ServiceError('not_found', 'Invalid access code');
  }
  return tiers.map(withAvailability);
}

/**
 * Default currency for a new tier: the event's most common tier currency, so we
 * never drift into mixed-currency carts (e.g. a legacy 'USD' default sneaking
 * into a CAD event); 'CAD' for an event with no tiers yet.
 */
async function resolveDefaultCurrency(eventId: string): Promise<string> {
  try {
    const currencies = await listTicketTypeCurrencies(eventId);
    if (currencies.length === 0) return FALLBACK_CURRENCY;
    const counts = new Map<string, number>();
    for (const currency of currencies) counts.set(currency, (counts.get(currency) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    // Best effort: a failed lookup falls through with the fallback currency.
    return FALLBACK_CURRENCY;
  }
}

function assertValidNewTier(body: CreateTierBody): void {
  if (!body.name) {
    throw new ServiceError('invalid', 'name is required');
  }
  if (body.price === undefined || body.price < 0) {
    throw new ServiceError('invalid', 'price must be >= 0');
  }
}

/** Create a tier for an event (organizer only). */
export async function createTier(input: TierWriteInput<CreateTierBody>): Promise<TicketTypeRow> {
  const { eventId, actorDid, callerCookie } = input;
  await requireOrganizer(eventId, actorDid, callerCookie);

  const body = await input.readBody();
  const defaultCurrency = body.currency ? FALLBACK_CURRENCY : await resolveDefaultCurrency(eventId);
  const { name, description, price, currency = defaultCurrency, quantity, perks, sortOrder } = body;
  const { requiresRegistration, registrationFormId, accessCode } = body;
  assertValidNewTier(body);

  return insertTicketType({
    id: `tkt_type_${randomBytes(8).toString('hex')}`,
    eventId,
    name: name as string,
    description,
    price: price as number,
    currency,
    quantity,
    perks: perks || [],
    sortOrder: sortOrder ?? 0,
    requiresRegistration: requiresRegistration ?? false,
    registrationFormId: registrationFormId || null,
    accessCode: accessCode?.trim() || null,
  });
}

/** Update a tier under the append-only policy (organizer only). */
export async function updateTier(input: TierWriteInput<UpdateTierBody>): Promise<UpdateTierResult> {
  const { eventId, actorDid, callerCookie } = input;
  await requireOrganizer(eventId, actorDid, callerCookie);

  const body = await input.readBody();
  const { tierId } = body;
  if (!tierId) {
    throw new ServiceError('invalid', 'tierId is required');
  }

  const tier = await getTicketTypeForEvent(tierId, eventId);
  if (!tier) {
    throw new ServiceError('not_found', 'Tier not found');
  }

  const { updates, violations } = buildTierUpdates(body, tier);
  if (violations.length > 0) {
    throw new ServiceError('invalid', 'Append-only policy violation', { details: { violations } });
  }
  if (Object.keys(updates).length === 0) {
    return { tier, changed: false };
  }

  const updated = await updateTicketType(tierId, updates);
  return { tier: withAvailability(updated), changed: true };
}
