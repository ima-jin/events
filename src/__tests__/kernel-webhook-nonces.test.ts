import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileWebhookNonceStore } from '@/lib/kernel-webhook-nonces';

let directory: string;
const now = 1_000_000;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'events-nonces-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('durable webhook replay journal', () => {
  it('accepts exactly one concurrent consumption across independent adapters', async () => {
    const stores = Array.from({ length: 8 }, () => createFileWebhookNonceStore(directory, () => now));
    const results = await Promise.all(stores.map((store) => store.consume('fake-public-nonce', now + 600_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await createFileWebhookNonceStore(directory, () => now).consume('fake-public-nonce', now + 600_000)).toBe(false);
    expect((await stat(join(directory, 'nonces.json'))).mode & 0o777).toBe(0o600);
  });

  it('prunes expired evidence without evicting live nonces', async () => {
    let clock = now;
    const store = createFileWebhookNonceStore(directory, () => clock);
    expect(await store.consume('expired-public-nonce', now + 10)).toBe(true);
    expect(await store.consume('live-public-nonce', now + 1_000)).toBe(true);
    clock += 20;
    expect(await store.consume('expired-public-nonce', now + 1_000)).toBe(true);
    expect(await store.consume('live-public-nonce', now + 1_000)).toBe(false);
    const journal = JSON.parse(await readFile(join(directory, 'nonces.json'), 'utf8'));
    expect(Object.keys(journal)).toHaveLength(2);
  });

  it.each(['broken-json', 'null', '[]', '{"bad-key":123}', '{"' + 'a'.repeat(64) + '":"invalid-expiry"}'])(
    'fails closed for corrupt replay journal %s', async (contents) => {
      await writeFile(join(directory, 'nonces.json'), contents);
      await expect(createFileWebhookNonceStore(directory, () => now).consume('nonce', now + 1_000)).rejects.toThrow();
      expect(await readFile(join(directory, 'nonces.json'), 'utf8')).toBe(contents);
    },
  );

  it.each([now, now - 1, Number.NaN, 1.5])('rejects invalid expiry %s', async (expiry) => {
    await expect(createFileWebhookNonceStore(directory, () => now).consume('nonce', expiry)).rejects.toThrow('Invalid webhook nonce expiry');
  });

  it('fails closed when the storage directory is not a directory', async () => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, '');
    await expect(createFileWebhookNonceStore(file, () => now).consume('nonce', now + 1_000)).rejects.toThrow();
  });

  it('fails closed at capacity without losing live replay evidence', async () => {
    const entries = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [
      createHash('sha256').update(String(index)).digest('hex'), now + 1_000,
    ]));
    await writeFile(join(directory, 'nonces.json'), JSON.stringify(entries));
    await expect(createFileWebhookNonceStore(directory, () => now).consume('new-nonce', now + 1_000)).rejects.toThrow('full');
    expect(Object.keys(JSON.parse(await readFile(join(directory, 'nonces.json'), 'utf8')))).toHaveLength(100_000);
  });
});
