/**
 * View models + pure helpers for the public event page and ticket purchase UI.
 *
 * Everything the browser (and the server-rendered page) ever sees about an
 * event goes through {@link toPublicEventView} / {@link toPublicTier}: explicit
 * field allow-lists, so the event's `privateKey`, the organizer's e-Transfer
 * address, the `.fair` manifest and tier access codes can never leak into
 * component props by accident (refs imajin-ai#2772).
 */

/** Hard cap on tickets of one type per order (mirrors the checkout routes). */
export const MAX_QUANTITY_PER_TIER = 20;
const DEFAULT_MAX_PER_ORDER = 10;
const DEFAULT_LOCALE = 'en-CA';
const SCHEDULE_LOCALE = 'en-US';

export type LocationType = 'physical' | 'virtual' | 'hybrid';

export interface PublicTier {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  quantity: number | null;
  /** Remaining tickets; `null` = unlimited. */
  available: number | null;
  perks: string[];
  maxPerOrder: number | null;
}

export interface EventTheme {
  emoji: string;
  gradient: [string, string];
}

export interface PublicEventView {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  status: string;
  accessMode: string;
  eventType: string;
  locationType: LocationType;
  venue: string | null;
  address: string | null;
  city: string | null;
  imageUrl: string | null;
  featured: boolean;
  theme: EventTheme;
  /** Per-event cap on tickets per order (event metadata), if the organizer set one. */
  maxTicketsPerOrder: number | null;
  /** Whether the organizer accepts Interac e-Transfer (the address itself stays server-side). */
  etransferEnabled: boolean;
}

type Raw = Record<string, unknown>;

const GRADIENTS: Record<string, [string, string]> = {
  orange: ['from-orange-500', 'to-amber-600'],
  blue: ['from-blue-500', 'to-indigo-600'],
  green: ['from-green-500', 'to-emerald-600'],
  purple: ['from-purple-500', 'to-pink-600'],
  red: ['from-red-500', 'to-rose-600'],
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

function isLocationType(value: unknown): value is LocationType {
  return value === 'physical' || value === 'virtual' || value === 'hybrid';
}

/** Resolve the location type, falling back to the legacy `isVirtual` flag. */
export function resolveLocationType(event: Raw): LocationType {
  if (isLocationType(event.locationType)) return event.locationType;
  return event.isVirtual === true ? 'virtual' : 'physical';
}

export function resolveEventTheme(metadata: Raw): EventTheme {
  const theme = (metadata.theme ?? {}) as { color?: string; emoji?: string; gradient?: [string, string] };
  const gradient = theme.gradient ?? GRADIENTS[theme.color ?? 'orange'] ?? GRADIENTS.orange;
  return { emoji: theme.emoji ?? '🎉', gradient };
}

/** Allow-listed, serialisable projection of one public ticket tier. */
export function toPublicTier(row: Raw): PublicTier {
  const perks = Array.isArray(row.perks) ? row.perks.filter((p): p is string => typeof p === 'string') : [];
  return {
    id: String(row.id),
    name: String(row.name),
    description: str(row.description),
    price: num(row.price) ?? 0,
    currency: str(row.currency) ?? 'CAD',
    quantity: num(row.quantity),
    available: num(row.available),
    perks,
    maxPerOrder: num(row.maxPerOrder),
  };
}

/** Allow-listed, serialisable projection of a public event row. */
export function toPublicEventView(event: Raw): PublicEventView {
  const metadata = (event.metadata ?? {}) as Raw;
  return {
    id: String(event.id),
    title: String(event.title),
    description: str(event.description),
    startsAt: iso(event.startsAt) ?? new Date(0).toISOString(),
    endsAt: iso(event.endsAt),
    timezone: str(event.timezone) ?? 'UTC',
    status: str(event.status) ?? 'draft',
    accessMode: str(event.accessMode) ?? 'public',
    eventType: str(event.eventType) ?? 'event',
    locationType: resolveLocationType(event),
    venue: str(event.venue),
    address: str(event.address),
    city: str(event.city),
    imageUrl: str(event.imageUrl),
    featured: metadata.featured === true,
    theme: resolveEventTheme(metadata),
    maxTicketsPerOrder: num(metadata.maxTicketsPerOrder),
    etransferEnabled: Boolean(str(event.emtEmail)),
  };
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** Tiers an anonymous visitor may see: access-code tiers stay hidden until unlocked. */
export function visibleTiers(rows: Raw[]): { tiers: PublicTier[]; hasHiddenTiers: boolean } {
  const open = rows.filter((row) => !str(row.accessCode));
  return { tiers: open.map(toPublicTier), hasHiddenTiers: open.length < rows.length };
}

/** Append `extra` tiers (e.g. unlocked by an access code) without duplicating ids. */
export function mergeTiers(base: PublicTier[], extra: PublicTier[]): PublicTier[] {
  const known = new Set(base.map((tier) => tier.id));
  return [...base, ...extra.filter((tier) => !known.has(tier.id))];
}

export function isFreeTier(tier: Pick<PublicTier, 'price'>): boolean {
  return tier.price === 0;
}

export function isSoldOut(tier: Pick<PublicTier, 'available'>): boolean {
  return tier.available !== null && tier.available <= 0;
}

/** Most tickets of `tier` one order may hold: tier override > event cap > 10, bounded by stock and 20. */
export function effectiveMax(tier: PublicTier, eventMax: number | null): number {
  const cap = Math.min(tier.maxPerOrder ?? eventMax ?? DEFAULT_MAX_PER_ORDER, MAX_QUANTITY_PER_TIER);
  return Math.max(0, Math.min(cap, tier.available ?? MAX_QUANTITY_PER_TIER));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency }).format(amount);
}

export function formatCents(cents: number, currency: string): string {
  return formatPrice(cents / 100, currency);
}

export function formatDeadline(isoDate: string): string {
  return new Date(isoDate).toLocaleString(DEFAULT_LOCALE, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export interface EventSchedule {
  date: string;
  time: string;
  endTime: string | null;
  /** Set only when the event ends on a different calendar day. */
  endDate: string | null;
}

export function formatEventSchedule(startsAt: string, endsAt: string | null, timeZone: string): EventSchedule {
  const start = new Date(startsAt);
  const timeOpts = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone } as const;
  const date = start.toLocaleDateString(SCHEDULE_LOCALE, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone,
  });
  const time = start.toLocaleTimeString(SCHEDULE_LOCALE, timeOpts);
  if (!endsAt) return { date, time, endTime: null, endDate: null };

  const end = new Date(endsAt);
  const dayOf = (d: Date) => d.toLocaleDateString(SCHEDULE_LOCALE, { timeZone });
  const endDate = dayOf(end) === dayOf(start)
    ? null
    : end.toLocaleDateString(SCHEDULE_LOCALE, { weekday: 'long', month: 'long', day: 'numeric', timeZone });
  return { date, time, endTime: end.toLocaleTimeString(SCHEDULE_LOCALE, timeOpts), endDate };
}

export interface LocationCard {
  icon: string;
  title: string;
  lines: string[];
}

const LOCATION_FALLBACKS: Record<LocationType, { icon: string; title: string }> = {
  physical: { icon: '📍', title: 'TBA' },
  virtual: { icon: '💻', title: 'Virtual Event' },
  hybrid: { icon: '💻📍', title: 'Hybrid Event' },
};

/** Venue/address lines for the location card. Virtual join links are deliberately never exposed here. */
export function describeLocation(event: Pick<PublicEventView, 'locationType' | 'venue' | 'address' | 'city'>): LocationCard {
  const fallback = LOCATION_FALLBACKS[event.locationType];
  if (event.locationType === 'virtual') return { ...fallback, lines: [] };
  const lines = [event.address, event.city].filter((line): line is string => Boolean(line));
  return { icon: fallback.icon, title: event.venue ?? fallback.title, lines };
}

const SALES_CLOSED: Record<string, string> = {
  cancelled: 'Ticket sales are closed — this event was cancelled.',
  completed: 'This event has ended. Ticket sales are closed.',
};

export function salesClosedMessage(status: string): string {
  return SALES_CLOSED[status] ?? 'Ticket sales are not currently available.';
}

/** Statuses only the creator may view; everyone else gets a 404. */
export function isHiddenStatus(status: string): boolean {
  return status === 'draft' || status === 'paused';
}
