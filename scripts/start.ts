import { AsyncLocalStorage } from 'node:async_hooks';
import { startClaimServer, startVaultServer } from '../src/lib/vault-boot';
// The SDK also exports Next header helpers, which capture this global at import.
// Establish Node's async context without importing any Next/server module early.
(globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage })
  .AsyncLocalStorage ??= AsyncLocalStorage;

async function main(): Promise<void> {
  const claimOnly = process.argv.includes('--claim-only');
  const start = async () => {
    const { startServer } = await import('./server');
    await startServer({ dev: process.argv.includes('--dev'), claimOnly });
  };
  if (claimOnly) {
    await startClaimServer(start);
  } else {
    await startVaultServer(start);
  }
}

main().catch(() => {
  // SDK, configuration and server errors can contain credentials. Never print them.
  console.error('Events startup failed; verify the app keystore and /jin manifest sync, App secrets set/rotate and owner countersign. No server is ready.');
  process.exitCode = 1;
});
