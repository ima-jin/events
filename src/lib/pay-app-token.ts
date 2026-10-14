/**
 * Events' own app-service token for the pay service (imajin-ai#2739).
 *
 * Events is a registered app. It authenticates checkout, settlement, refund
 * and charge-pledges calls as ITSELF with an app-service token minted from the
 * kernel by proving possession of its own signing key — never a shared key.
 *
 * The signing key is read through `loadAppSigningKey` using the local
 * bootstrap keystore created by the browser claim page, and kept in memory
 * only. Environment claiming is disabled. This module does not mint or
 * invent an app DID or key: when events is not registered/provisioned yet,
 * `loadAppSigningKey` throws and the callers fail closed.
 *
 * Operator prerequisites (see README.md and docs/REGISTRATION.md):
 *   - events registered as an app, signing key provisioned (`apps.provision`);
 *   - `pay:settle`, `pay:refund` and `pay:charge-pledges` approved for events'
 *     app DID via the operator's `apps:service-scopes` card.
 */
import { loadAppSigningKey } from '@ima-jin/auth-client';
import { createAppServiceTokenProvider, type AppServiceTokenProvider } from './app-service-token';

// Held on `globalThis` (not a module-level `let`): Next can bundle this module into more than one
// route chunk of the same server process; all copies should share one token provider.
const PROVIDER_KEY = Symbol.for('@ima-jin/events:pay-app-token-provider');
type ProviderHolder = { [PROVIDER_KEY]?: Promise<AppServiceTokenProvider> | null };

function holder(): ProviderHolder {
  return globalThis as ProviderHolder;
}

async function createProvider(): Promise<AppServiceTokenProvider> {
  const kernelUrl = process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) {
    throw new Error('events pay app token: IMAJIN_KERNEL_URL is not set');
  }
  const signingKey = await loadAppSigningKey({ kernelUrl, hostHint: 'events', claimCode: '' });
  return createAppServiceTokenProvider({ kernelUrl, appDid: signingKey.appDid, privateKey: signingKey.privateKey });
}

function getProvider(): Promise<AppServiceTokenProvider> {
  const h = holder();
  const existing = h[PROVIDER_KEY];
  if (existing) return existing;

  const created = createProvider().catch((err: unknown) => {
    // Don't cache a failed load — the next call retries (e.g. once the operator has provisioned the app).
    h[PROVIDER_KEY] = null;
    throw err;
  });
  h[PROVIDER_KEY] = created;
  return created;
}

/** Events' current app-service token (minted/refreshed as needed). Throws when it cannot be obtained. */
export async function getPayAppToken(): Promise<string> {
  return (await getProvider()).getToken();
}

/** Drop the cached token — call after the pay service answered 401 so the next call mints a fresh one. */
export async function invalidatePayAppToken(): Promise<void> {
  (await getProvider()).invalidate();
}

/** Forget the cached provider (tests only). */
export function resetPayAppTokenForTests(): void {
  holder()[PROVIDER_KEY] = null;
}
