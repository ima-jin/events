import { loadFromVault } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

type SecretName = 'SESSION_SECRET' | 'TICKET_QR_SECRET';
const SELF_SECRETS = Symbol.for('imajin.events.selfSecrets');
interface SecretStore {
  [SELF_SECRETS]?: Readonly<Record<SecretName, string>>;
}


export function warnIgnoredSelfSecretEnv(): void {
  for (const { name, kind } of manifest.secrets) {
    if (process.env[name]) {
      const source = kind === 'operator-supplied' ? 'loaded from' : 'issued by';
      console.warn(`${name} is ignored; it is ${source} the kernel vault. Delete it from the env file.`);
    }
  }
}

/** Called only after the SDK establishes this app's bound bootstrap keystore. */
export async function loadSelfSecrets(appDid: string): Promise<void> {
  const store = globalThis as SecretStore;
  delete store[SELF_SECRETS];
  const values = await manifest.secrets.filter(({ kind }) => kind === 'random-32B').reduce<Promise<Record<SecretName, string>>>(
    async (pending, declaration) => {
      const loaded = await pending;
      const name = declaration.name as SecretName;
      loaded[name] = await loadRequiredSecret(name, appDid);
      return loaded;
    },
    Promise.resolve({} as Record<SecretName, string>),
  );
  // Publish only once every required secret has loaded and validated.
  store[SELF_SECRETS] = Object.freeze(values);
}

/** Safe to log; never includes SDK errors, response bodies or credential values. */
export class VaultSecretError extends Error {
  constructor(name: SecretName) {
    super(`${name}: vault secret unavailable; on /jin use Sync manifest secrets and countersign, then restart events.`);
    this.name = 'VaultSecretError';
  }
}

async function loadRequiredSecret(name: SecretName, appDid: string): Promise<string> {
  try {
    // One required name per call lets errors identify the failed declaration,
    // without inspecting (or logging) provider-controlled error messages.
    const credentials = await loadFromVault({
      appDid,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: [{ key: name, onMissing: 'fail' }],
    });
    const value = credentials.values[name];
    if (typeof value !== 'string' || value.length < 64) throw new VaultSecretError(name);
    return value;
  } catch {
    throw new VaultSecretError(name);
  }
}

export function getSelfSecret(name: SecretName): string {
  const value = (globalThis as SecretStore)[SELF_SECRETS]?.[name];
  if (!value) throw new VaultSecretError(name);
  return value;
}

/** Test-only: models a fresh process, without any persistent secret cache. */
export function resetSelfSecretsForTests(): void {
  delete (globalThis as SecretStore)[SELF_SECRETS];
}
