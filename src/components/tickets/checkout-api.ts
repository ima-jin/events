/**
 * Browser-side calls to this app's own checkout routes (`/api/checkout*`) and
 * the public tier-unlock route. Same-origin relative fetches through
 * `withBasePath` — no absolute URLs, no kernel access from the browser.
 */
import { withBasePath } from '@/lib/base-path';
import { toPublicTier, type PublicTier } from '@/lib/public-event';

/** `POST /api/checkout` answers 409 with this code when the organizer has no card rail (imajin-ai#2757). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class CheckoutError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'CheckoutError';
    this.status = status;
    this.code = code;
  }
}

export function isNoCardRail(error: unknown): boolean {
  return error instanceof CheckoutError && error.status === 409 && error.code === SELLER_NO_CARD_RAIL;
}

export interface CartLine {
  ticketTypeId: string;
  quantity: number;
}

export interface BuyerDetails {
  email?: string;
  name?: string;
}

export interface EtransferInstructions {
  orderId: string;
  email: string;
  amount: number;
  currency: string;
  memo: string;
  deadline: string;
  message: string;
}

/** A checkout that completed in-page (card checkout navigates away instead). */
export type FinishedCheckout =
  | { kind: 'etransfer'; instructions: EtransferInstructions }
  | { kind: 'verification'; message: string }
  | { kind: 'balance'; orderId: string }
  | { kind: 'free' };

/** What a checkout attempt hands back to the UI. */
export type CheckoutResult = FinishedCheckout | { kind: 'redirect'; url: string };

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  fallback: string;
}

async function request<T>(path: string, { method = 'POST', body, fallback }: RequestOptions): Promise<{ data: T }> {
  const response = await fetch(withBasePath(path), {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) {
    throw new CheckoutError(data.error || fallback, response.status, data.code);
  }
  return { data };
}

const withInvite = (invite?: string) => (invite ? { invite } : {});

function buyerFields(buyer: BuyerDetails) {
  return {
    ...(buyer.email && { email: buyer.email.trim() }),
    ...(buyer.name && { name: buyer.name.trim() }),
  };
}

export async function startCardCheckout(eventId: string, items: CartLine[], invite?: string): Promise<CheckoutResult> {
  const { data } = await request<{ url: string }>('/api/checkout', {
    body: { eventId, items, ...withInvite(invite) },
    fallback: 'Failed to create checkout',
  });
  return { kind: 'redirect', url: data.url };
}

export async function startBalanceCheckout(eventId: string, items: CartLine[], invite?: string): Promise<CheckoutResult> {
  const { data } = await request<{ orderId: string }>('/api/checkout/balance', {
    body: { eventId, items, ...withInvite(invite) },
    fallback: 'Balance checkout failed',
  });
  return { kind: 'balance', orderId: data.orderId };
}

interface EtransferResponse {
  orderId?: string;
  instructions?: Omit<EtransferInstructions, 'orderId'>;
  verificationSent?: boolean;
  message?: string;
}

export async function reserveEtransfer(
  eventId: string,
  items: CartLine[],
  buyer: BuyerDetails,
  invite?: string,
): Promise<CheckoutResult> {
  const { data } = await request<EtransferResponse>('/api/checkout/etransfer', {
    body: { eventId, items, ...withInvite(invite), ...buyerFields(buyer) },
    fallback: 'Failed to create e-Transfer hold',
  });
  if (data.verificationSent || !data.instructions) {
    return { kind: 'verification', message: data.message ?? 'Check your email to confirm your reservation.' };
  }
  return { kind: 'etransfer', instructions: { ...data.instructions, orderId: data.orderId ?? '' } };
}

/** Free RSVP. An existing ticket (409) counts as success, as in the kernel UI. */
export async function rsvpFree(
  eventId: string,
  ticketTypeId: string,
  buyer: BuyerDetails,
  invite?: string,
): Promise<CheckoutResult> {
  try {
    await request('/api/checkout/free', {
      body: { eventId, ticketTypeId, ...withInvite(invite), ...buyerFields(buyer) },
      fallback: 'RSVP failed',
    });
  } catch (error) {
    if (!(error instanceof CheckoutError && error.status === 409)) throw error;
  }
  return { kind: 'free' };
}

/** Tiers revealed by an access/invite code. */
export async function unlockTiers(eventId: string, code: string): Promise<PublicTier[]> {
  const { data } = await request<{ tiers: Record<string, unknown>[] }>(
    `/api/events/${encodeURIComponent(eventId)}/tiers/unlock?code=${encodeURIComponent(code)}`,
    { method: 'GET', fallback: 'Failed to unlock. Please try again.' },
  );
  return data.tiers.map(toPublicTier);
}

/** The signed-in buyer's balance in cents, or `null` when unavailable. */
export async function fetchBalanceCents(): Promise<number | null> {
  try {
    const { data } = await request<{ balance?: number; unavailable?: boolean }>('/api/balance', {
      method: 'GET',
      fallback: 'Balance unavailable',
    });
    return typeof data.balance === 'number' && !data.unavailable ? Math.round(data.balance * 100) : null;
  } catch {
    return null;
  }
}
