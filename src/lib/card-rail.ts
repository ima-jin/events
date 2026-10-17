import { kernelBaseUrl, serviceUrl } from '@/lib/kernel';

export interface CardRailReadiness {
  /** null means unavailable, not that the seller is ready. */
  cardEnabled: boolean | null;
  setupUrl: string | null;
}

const CHECK_TIMEOUT_MS = 5000;

/** Public, unauthenticated endpoint; never forward app or user credentials. */
export function cardRailCheckUrl(creatorDid: string): string | null {
  const payUrl = serviceUrl('pay');
  return payUrl ? `${payUrl}/api/card-rail/check?did=${encodeURIComponent(creatorDid)}` : null;
}

export async function getCardRailReadiness(creatorDid: string): Promise<CardRailReadiness> {
  const base = kernelBaseUrl();
  const setupUrl = base ? `${base}/auth/connectors/stripe` : null;
  const unavailable: CardRailReadiness = { cardEnabled: null, setupUrl };
  const url = cardRailCheckUrl(creatorDid);
  if (!url) return unavailable;

  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return unavailable;
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || !('cardEnabled' in data)) return unavailable;
    if (typeof data.cardEnabled !== 'boolean') return unavailable;
    return { cardEnabled: data.cardEnabled, setupUrl };
  } catch {
    return unavailable;
  }
}
