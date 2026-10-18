import type { VaultBoot } from '@ima-jin/auth-client';

export interface ServerConfig {
  databaseUrl: string;
}

const BOOT = Symbol.for('imajin.events.vaultBoot');
interface BootStore {
  [BOOT]?: { boot?: VaultBoot<ServerConfig>; claimOnly: boolean };
}
const store = globalThis as BootStore;

/** The same SDK boundary is visible to instrumentation and separately bundled routes. */
export function getServerConfig(): Readonly<ServerConfig> {
  const boot = store[BOOT]?.boot;
  if (!boot) throw new Error('Events vault configuration unavailable');
  return boot.getConfig();
}

export function isClaimOnly(): boolean {
  return store[BOOT]?.claimOnly === true;
}

/** Never import application/server modules outside this callback. No env fallback. */
export async function startVaultServer<Result>(
  start: () => Promise<Result>,
): Promise<Result> {
  if (store[BOOT]) throw new Error('Events startup already attempted');
  const state: NonNullable<BootStore[typeof BOOT]> = { claimOnly: false };
  store[BOOT] = state;
  // Native ESM avoids the SDK's ESM-only transitive dependencies being required
  // through its CommonJS entrypoint by a plain Node/tsx launcher.
  const { createVaultBoot } = await import('@ima-jin/auth-client');
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
  state.boot = boot;
  return boot.start(start);
}

/** Explicit onboarding mode: it never loads DB credentials or opens ordinary routes. */
export async function startClaimServer<Result>(start: () => Promise<Result>): Promise<Result> {
  if (store[BOOT]) throw new Error('Events startup already attempted');
  store[BOOT] = { claimOnly: true };
  return start();
}
