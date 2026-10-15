import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileKernelWebhookPinStore, type KernelWebhookNonceStore } from '@ima-jin/auth/kernel-webhook';

/** Persistent replay journal shared by workers on one local filesystem; contains no credentials. */
export function createFileWebhookNonceStore(
  directory = join(process.cwd(), 'data', 'kernel-webhook-nonces'),
  clock = Date.now,
): KernelWebhookNonceStore {
  const locks = createFileKernelWebhookPinStore(directory);
  const filename = join(directory, 'nonces.json');

  async function load(): Promise<Record<string, number>> {
    let contents: string;
    try {
      contents = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.entries(parsed).some(([key, expiry]) =>
        !/^[0-9a-f]{64}$/.test(key) || !Number.isSafeInteger(expiry))) {
      throw new Error('Invalid webhook replay journal');
    }
    return parsed as Record<string, number>;
  }

  return {
    consume(key, expiresAt) {
      return locks.withLock('events-replay-journal', async () => {
        const entries = await load();
        const now = clock();
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
          throw new Error('Invalid webhook nonce expiry');
        }
        for (const [nonce, expiry] of Object.entries(entries)) {
          if (expiry <= now) delete entries[nonce];
        }
        const digest = createHash('sha256').update(key).digest('hex');
        if (Object.hasOwn(entries, digest)) return false;
        if (Object.keys(entries).length >= 100_000) throw new Error('Webhook replay journal full');
        entries[digest] = expiresAt;
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
          await rename(temporary, filename);
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        return true;
      });
    },
  };
}
