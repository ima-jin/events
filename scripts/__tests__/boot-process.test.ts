import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateBootstrapKeypair, writeKeystore, type AppSecretFetchPayload } from '@ima-jin/auth-client';
import { deriveXKeypairFromEd25519, sealSecret, wrapFieldKey } from '@ima-jin/vault-core';
import { describe, expect, it } from 'vitest';

const FAKE_DATABASE = 'FAKE_TEST_DATABASE_URL_NOT_A_CONNECTION_STRING';
const FAKE_SELF_SECRET = 'FAKE_TEST_SELF_SECRET_ONLY_'.repeat(4);
const APP_DID = 'did:imajin:events-process-test';

function childEnv(port: number, keystorePath: string, kernelUrl: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port), APP_DB_SCHEMA: 'events',
    IMAJIN_APP_DID: APP_DID, IMAJIN_APP_KEYSTORE: keystorePath,
    IMAJIN_KERNEL_URL: kernelUrl, NEXT_PUBLIC_APP_URL: 'https://events.example.invalid',
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

describe('launcher process contract', () => {
  it('fails closed before listening with no keystore and prints only the fixed diagnostic', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/start.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: childEnv(0, '/fixture/absent-events-keystore.json', 'https://kernel.example.invalid'),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      'Events startup failed; verify the app keystore and /jin manifest sync, App secrets set/rotate and owner countersign. No server is ready.',
    );
  });

  // CI runs this again after build; the ordinary pre-build test run needs no build artifact.
  it.skipIf(process.env.EVENTS_BOOT_INTEGRATION !== '1')(
    'boots the compiled Next app using encrypted credentials shared across its bundles', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'events-compiled-boot-'));
      const keystorePath = join(directory, 'bootstrap.json');
      writeKeystore(keystorePath, generateBootstrapKeypair());
      const sender = deriveXKeypairFromEd25519(generateBootstrapKeypair().privateKey, 'events-process-test');
      const requestedKeys: string[] = [];
      const kernel = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/apps/signing-key/fetch') {
          response.end(JSON.stringify({
            appDid: APP_DID, privateKey: 'FAKE_SIGNING_TEST_ONLY', publicKey: 'FAKE_PUBLIC_TEST_ONLY',
          }));
          return;
        }
        const payload = JSON.parse(body) as AppSecretFetchPayload;
        requestedKeys.push(...payload.keys);
        const fieldKey = randomBytes(32);
        response.end(JSON.stringify({
          version: 1, senderXPub: sender.publicKey,
          wrappedKey: wrapFieldKey(fieldKey, payload.recipientXPub, sender.privateKey),
          sealed: sealSecret(JSON.stringify({
            domain: payload.domain, appDid: payload.appDid, nonce: payload.nonce, keys: payload.keys,
            values: { [payload.keys[0]]: payload.keys[0] === 'DATABASE_URL' ? FAKE_DATABASE : FAKE_SELF_SECRET },
            missing: [],
          }), fieldKey),
        }));
      });
      let child: ChildProcess | undefined;
      try {
        const kernelPort = await listen(kernel);
        const reservation = createServer();
        const port = await listen(reservation);
        await close(reservation);
        child = spawn(process.execPath, ['--import', 'tsx', 'scripts/start.ts'], {
          cwd: process.cwd(), env: childEnv(port, keystorePath, `http://127.0.0.1:${kernelPort}`),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout?.on('data', (chunk) => { output += chunk; });
        child.stderr?.on('data', (chunk) => { output += chunk; });
        try {
          await expect.poll(async () => {
            if (child?.exitCode !== null) return 'PROCESS_EXITED';
            try {
              const response = await fetch(`http://127.0.0.1:${port}/api/health`);
              if (response.status !== 200) return 'NOT_READY';
              return (await response.json()).claimed;
            } catch { return 'NOT_LISTENING'; }
          }, { timeout: 20_000, interval: 100 }).toBe(true);
        } catch {
          throw new Error(output
            .replaceAll(FAKE_DATABASE, '[redacted]')
            .replaceAll(FAKE_SELF_SECRET, '[redacted]')
            .replaceAll('FAKE_SIGNING_TEST_ONLY', '[redacted]'));
        }
        expect(requestedKeys).toEqual(['DATABASE_URL', 'SESSION_SECRET', 'TICKET_QR_SECRET']);
        expect(output).not.toContain(FAKE_DATABASE);
        expect(output).not.toContain(FAKE_SELF_SECRET);
        expect(output).not.toContain('FAKE_SIGNING_TEST_ONLY');
      } finally {
        if (child) await stop(child);
        await close(kernel);
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30_000,
  );
});
