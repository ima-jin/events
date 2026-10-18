import { createVaultBoot, type VaultBoot } from '@ima-jin/auth-client';

export interface ServerConfig {
  databaseUrl: string;
}

const BOOT = Symbol.for('imajin.events.vaultBoot');
const CLAIM_ONLY = Symbol.for('imajin.events.claimOnly');
interface BootStore {
  [BOOT]?: VaultBoot<ServerConfig>;
  [CLAIM_ONLY]?: boolean;
}
const store = globalThis as BootStore;

/** The same SDK boundary is visible to instrumentation and separately bundled routes. */
export function getServerConfig(): Readonly<ServerConfig> {
  if (!store[BOOT]) throw new Error('Events vault configuration unavailable');
  return store[BOOT].getConfig();
}

export function isClaimOnly(): boolean {
  return store[CLAIM_ONLY] === true;
}

/** Never import application/server modules outside this callback. No env fallback. */
export async function startVaultServer<Result>(
  start: () => Promise<Result>,
): Promise<Result> {
  if (store[BOOT] || store[CLAIM_ONLY]) throw new Error('Events startup already attempted');
  const boot = createVaultBoot<ServerConfig>({
    vault: {
      appDid: process.env.IMAJIN_APP_DID,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
    },
    configure: ({ values }) => {
      const databaseUrl = values.DATABASE_URL;
      if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
        throw new Error('Required vault credential unavailable');
      }
      return { databaseUrl };
    },
  });
  store[BOOT] = boot;
  return boot.start(start);
}

/** Explicit onboarding mode: it never loads DB credentials or opens ordinary routes. */
export async function startClaimServer<Result>(start: () => Promise<Result>): Promise<Result> {
  if (store[BOOT] || store[CLAIM_ONLY]) throw new Error('Events startup already attempted');
  store[CLAIM_ONLY] = true;
  return start();
}
