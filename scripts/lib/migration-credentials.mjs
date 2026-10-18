/** Load only through the public SDK; plain Node launchers use --import=tsx for SDK ESM resolution. */
async function fetchCredentials(options) {
  const { loadFromVault } = await import('@ima-jin/auth-client');
  return loadFromVault(options);
}

/**
 * DATABASE_URL env is never a migration input. The separate override is restricted
 * to explicitly opted-in disposable tests/CI, and is forbidden by deploy preflight.
 * @param {Record<string, string | undefined>} env
 */
export async function loadMigrationDatabaseUrl(env, load = fetchCredentials) {
  try {
    let value;
    if (env.MIGRATIONS_TEST_DATABASE_URL !== undefined) {
      if (env.CI !== 'true' && env.NODE_ENV !== 'test') throw new Error('Test mode required');
      value = env.MIGRATIONS_TEST_DATABASE_URL;
    } else {
      const credentials = await load({
        appDid: env.IMAJIN_APP_DID,
        kernelUrl: env.IMAJIN_KERNEL_URL,
        keystorePath: env.IMAJIN_APP_KEYSTORE,
        keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
      });
      value = credentials.values.DATABASE_URL;
    }
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Credential unavailable');
    return value;
  } catch {
    throw new Error('Migration database credential unavailable; verify the app keystore and /jin App secrets set/rotate with owner countersign.');
  }
}
