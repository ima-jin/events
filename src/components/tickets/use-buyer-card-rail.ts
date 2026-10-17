'use client';

import { useEffect, useState } from 'react';

export type BuyerCardRail = 'checking' | 'ready' | 'missing' | 'unavailable';
const CHECK_TIMEOUT_MS = 5000;
function readinessStatus(data: unknown): BuyerCardRail {
  if (typeof data !== 'object' || data === null || !('cardEnabled' in data) || typeof data.cardEnabled !== 'boolean') {
    return 'unavailable';
  }
  return data.cardEnabled ? 'ready' : 'missing';
}

async function checkReadiness(url: string, signal: AbortSignal): Promise<BuyerCardRail> {
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal });
    return response.ok ? readinessStatus(await response.json()) : 'unavailable';
  } catch {
    // Unknown readiness never exposes a card button. Other rails still work.
    return 'unavailable';
  }
}

/**
 * Check from the buyer's browser, never on every server page render (the
 * public kernel endpoint is limited per IP). No polling or quantity dependency.
 */
export function useBuyerCardRail(url: string | null, enabled: boolean): BuyerCardRail {
  const [result, setResult] = useState<{ url: string; status: BuyerCardRail } | null>(null);

  useEffect(() => {
    if (!url || !enabled) return;
    const checkUrl = url;
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    async function check() {
      let status: BuyerCardRail;
      try {
        status = await checkReadiness(checkUrl, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
      if (active) setResult({ url: checkUrl, status });
    }
    check().catch(() => undefined);
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [url, enabled]);

  if (!url) return 'unavailable';
  return result?.url === url ? result.status : 'checking';
}
