import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prepare, handle, nextMock } = vi.hoisted(() => {
  const prepare = vi.fn(async () => {});
  const handle = vi.fn(async (_request: IncomingMessage, response: ServerResponse) => {
    response.end('FAKE_NEXT_RESPONSE');
  });
  return { prepare, handle, nextMock: vi.fn(() => ({ prepare, getRequestHandler: () => handle })) };
});
vi.mock('next', () => ({ default: nextMock }));
import { startServer } from '../server';

let server: Server | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PORT', '0');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server?.close(() => resolve()); });
    server = undefined;
  }
  vi.unstubAllEnvs();
});

function origin(): string {
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

describe('delayed Next server', () => {
  it('prepares Next before listening and forwards ordinary requests in normal mode', async () => {
    server = await startServer({ dev: false, claimOnly: false });
    expect(nextMock).toHaveBeenCalledWith({ dev: false, port: 0, hostname: '127.0.0.1' });
    expect(prepare).toHaveBeenCalledOnce();
    const response = await fetch(`${origin()}/events/api/health`);
    expect(await response.text()).toBe('FAKE_NEXT_RESPONSE');
    expect(handle).toHaveBeenCalledOnce();
  });

  it('keeps claim-only traffic isolated even when the inner app would allow a request', async () => {
    server = await startServer({ dev: true, claimOnly: true });
    for (const path of [
      '/events', '/events/api/health', '/events/api/events', '/events/claim/../api/events',
      '/events/_next/image', '/events/_next/static/%2e%2e%2fapi/events',
    ]) {
      const response = await fetch(`${origin()}${path}`);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('Claim-only mode');
    }
    expect(handle).not.toHaveBeenCalled();
    for (const path of ['/events/claim', '/events/api/claim', '/events/claim?test=1', '/events/_next/static/fixture.js']) {
      const response = await fetch(`${origin()}${path}`);
      expect(await response.text()).toBe('FAKE_NEXT_RESPONSE');
    }
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it('supports an unprefixed claim-only listener', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
    server = await startServer({ dev: true, claimOnly: true });
    expect((await fetch(`${origin()}/claim`)).status).toBe(200);
    expect((await fetch(`${origin()}/`)).status).toBe(503);
  });

  it('sanitizes request handler failures', async () => {
    handle.mockRejectedValueOnce(new Error('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE'));
    server = await startServer({ dev: false, claimOnly: false });
    const response = await fetch(`${origin()}/events`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Request unavailable');
  });

  it('does not listen when Next preparation fails', async () => {
    prepare.mockRejectedValueOnce(new Error('FAKE_PREPARE_FAILURE'));
    await expect(startServer({ dev: false, claimOnly: false })).rejects.toThrow('FAKE_PREPARE_FAILURE');
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a listener bind failure', async () => {
    server = await startServer({ dev: false, claimOnly: false });
    vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
    await expect(startServer({ dev: false, claimOnly: false })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
