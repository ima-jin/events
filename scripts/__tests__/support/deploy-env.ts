/** Public configuration only: no database credential, signing material or test bypass. */
export function validEnv(target = 'dev'): Record<string, string> {
  const host = target === 'dev' ? 'dev-jin.imajin.ai' : 'jin.imajin.ai';
  const base = `https://${host}`;
  return {
    APP_DB_SCHEMA: 'events',
    IMAJIN_KERNEL_URL: base,
    IMAJIN_AUTH_URL: base,
    AUTH_SERVICE_URL: `${base}/auth`,
    NEXT_PUBLIC_IMAJIN_AUTH_URL: base,
    NEXT_PUBLIC_AUTH_URL: `${base}/auth`,
    NEXT_PUBLIC_APP_URL: `${base}/events`,
    NEXT_PUBLIC_EVENTS_URL: `${base}/events`,
    NEXT_PUBLIC_BASE_PATH: '/events',
    NEXT_PUBLIC_SERVICE_PREFIX: target === 'dev' ? 'dev-' : '',
    IMAJIN_ENV: target === 'dev' ? 'dev' : '',
    IMAJIN_APP_DID: 'did:imajin:fixture',
    IMAJIN_APP_KEYSTORE: `/fixture/events.${target}.keystore.json`,
  };
}
