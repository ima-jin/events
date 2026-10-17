import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';
import { publish, type DomainEvent } from '@/lib/domain-events';

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  getSigningIdentity: vi.fn(),
}));
vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));
vi.mock('@/lib/signing-identity', () => ({ getSigningIdentity: mocks.getSigningIdentity }));

const APP_DID = 'did:imajin:events-test';
const KERNEL = 'https://kernel.test';
const SUBJECT = 'did:imajin:attendee-test';
const TYPE = 'ticket.confirmed';
const event: DomainEvent = {
  issuer: SUBJECT,
  scope: 'events',
  subject: SUBJECT,
  payload: { eventId: 'event-test', interestDids: [SUBJECT] },
};
const fetchMock = vi.fn<typeof fetch>();
let token: string;

function minted(): Response {
  return Response.json({ token, expiresIn: 3600, scopes: [] });
}

function queuedDelivery(status = 201, body: unknown = { ok: true }): void {
  fetchMock.mockResolvedValueOnce(minted())
    .mockResolvedValueOnce(Response.json(body, { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('IMAJIN_KERNEL_URL', `${KERNEL}///`);
  vi.stubEnv('IMAJIN_AUTH_URL', undefined);
  vi.stubEnv('IMAJIN_APP_DID', APP_DID);
  vi.stubEnv('IMAJIN_EVENTS_PUBLISH_PATH', undefined);
  mocks.getSigningIdentity.mockReturnValue({ appDid: APP_DID, ...generateBootstrapKeypair() });
  token = randomBytes(32).toString('hex');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kernel domain event transport', () => {
  it('mints with the published SDK and posts to /api/events without an override', async () => {
    queuedDelivery();
    await expect(publish(TYPE, { ...event, correlationId: 'checkout-test', timestamp: 'ignored' })).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [mintUrl, mintOptions] = fetchMock.mock.calls[0];
    expect(mintUrl).toBe(`${KERNEL}/auth/api/apps/token/service`);
    expect(mintOptions).toMatchObject({ method: 'POST', redirect: 'error' });
    const proof = JSON.parse(mintOptions?.body as string);
    expect(proof).toEqual({
      appDid: APP_DID,
      nonce: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
      signature: expect.stringMatching(/^[a-f0-9]{128}$/),
    });
    // No audience override: the service endpoint's default imajin:apps is accepted by /api/events.
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe(`${KERNEL}/api/events`);
    expect(options).toMatchObject({
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      type: TYPE, subject: SUBJECT, payload: event.payload, correlationId: 'checkout-test',
    });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each(manifest.emittableEvents)('delivers declared %s without local-only authority fields', async (type) => {
    queuedDelivery();
    await publish(type, event);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      type, subject: SUBJECT, payload: event.payload,
    });
  });

  it.each([undefined, ''])('defaults an unset/empty override (%s)', async (path) => {
    vi.stubEnv('IMAJIN_EVENTS_PUBLISH_PATH', path);
    queuedDelivery();
    await publish(TYPE, event);
    expect(fetchMock.mock.calls[1][0]).toBe(`${KERNEL}/api/events`);
  });

  it('honors a kernel-relative override without changing the token endpoint', async () => {
    vi.stubEnv('IMAJIN_EVENTS_PUBLISH_PATH', '/custom/api/events');
    queuedDelivery();
    await publish(TYPE, event);
    expect(fetchMock.mock.calls[0][0]).toBe(`${KERNEL}/auth/api/apps/token/service`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${KERNEL}/custom/api/events`);
  });

  it('uses the existing IMAJIN_AUTH_URL fallback for both calls', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', undefined);
    vi.stubEnv('IMAJIN_AUTH_URL', KERNEL);
    queuedDelivery();
    await publish(TYPE, event);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${KERNEL}/auth/api/apps/token/service`, `${KERNEL}/api/events`,
    ]);
  });

  it('shares a cached token across concurrent and later publishes', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('/token/service') ? minted() : Response.json({ ok: true }, { status: 201 }));
    await Promise.all([publish(TYPE, event), publish('event.attendance', event)]);
    await publish('checkin.create', event);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/token/service'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'event_type_not_approved'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ])('logs HTTP %s without throwing or retrying', async (status, error) => {
    fetchMock.mockResolvedValueOnce(minted()).mockResolvedValueOnce(Response.json(
      { error }, { status, headers: { 'Retry-After': '60' } },
    ));
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledWith(
      { type: TYPE, status, retryAfter: '60' }, expect.stringContaining('operator-approved emittable_events'),
    );
  });

  it('invalidates a 401 token for the next event, never replaying the rejected one', async () => {
    queuedDelivery(401);
    queuedDelivery();
    await publish(TYPE, event);
    await publish('event.attendance', event);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${KERNEL}/auth/api/apps/token/service`, `${KERNEL}/api/events`,
      `${KERNEL}/auth/api/apps/token/service`, `${KERNEL}/api/events`,
    ]);
  });

  it('submits order.refunded unchanged and logs the current kernel reserved-type 403', async () => {
    queuedDelivery(403, { error: 'event_type_reserved' });
    await expect(publish('order.refunded', event)).resolves.toEqual({});
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).type).toBe('order.refunded');
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403, type: 'order.refunded' }), expect.any(String),
    );
  });

  it.each(['settlement.completed', 'payment.paid', 'attestation.issued'])('refuses kernel-owned %s locally', async (type) => {
    await expect(publish(type, event)).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith({ type }, expect.stringContaining('app domain events'));
  });

  it('logs the missing kernel URL setting at error level and never calls fetch', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', undefined);
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(mocks.error).toHaveBeenCalledWith({}, expect.stringContaining('IMAJIN_KERNEL_URL'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs missing IMAJIN_APP_DID at error level before loading credentials', async () => {
    vi.stubEnv('IMAJIN_APP_DID', undefined);
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(mocks.error).toHaveBeenCalledWith({ type: TYPE }, expect.stringContaining('IMAJIN_APP_DID'));
    expect(mocks.getSigningIdentity).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names IMAJIN_APP_KEYSTORE when signing credentials are missing, without leaking exceptions', async () => {
    mocks.getSigningIdentity.mockImplementationOnce(() => { throw new Error(token); });
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(mocks.error).toHaveBeenCalledWith({ type: TYPE }, expect.stringContaining('IMAJIN_APP_KEYSTORE'));
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a foreign signing identity', async () => {
    mocks.getSigningIdentity.mockReturnValue({ appDid: 'did:imajin:another-app', ...generateBootstrapKeypair() });
    await publish(TYPE, event);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith({ type: TYPE }, expect.stringContaining('IMAJIN_APP_DID'));
  });

  it.each([401, 403, 429])('logs token-mint HTTP %s safely and does not send an unauthenticated event', async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: token }, { status }));
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith({ type: TYPE }, expect.stringContaining('app-service token unavailable'));
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(token);
  });

  it('does not cache a failed mint', async () => {
    fetchMock.mockRejectedValueOnce(new Error('unreachable'));
    queuedDelivery();
    await publish(TYPE, event);
    await publish(TYPE, event);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('contains network/serialization errors and never logs event payloads', async () => {
    fetchMock.mockResolvedValueOnce(minted()).mockRejectedValueOnce(new Error(token));
    await expect(publish(TYPE, event)).resolves.toEqual({});
    expect(mocks.error).toHaveBeenCalledWith({ type: TYPE }, expect.stringContaining('delivery failed'));
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(token);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(publish(TYPE, { ...event, payload: cyclic })).resolves.toEqual({});
  });

  it.each(['api/events', '//external.test/events', 'https://external.test/events'])(
    'rejects unsafe override %s before minting', async (path) => {
      vi.stubEnv('IMAJIN_EVENTS_PUBLISH_PATH', path);
      await expect(publish(TYPE, event)).resolves.toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith({}, expect.stringContaining('IMAJIN_EVENTS_PUBLISH_PATH'));
    },
  );

  it.each(['not a url', 'file:///tmp/kernel'])('logs invalid kernel URL %s without echoing its value', async (url) => {
    vi.stubEnv('IMAJIN_KERNEL_URL', url);
    await publish(TYPE, event);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith({}, expect.stringContaining('invalid IMAJIN_KERNEL_URL'));
  });
});

describe('approval declarations', () => {
  it('declares every concrete supported publish type without reserved order/settlement types', () => {
    const root = new URL('../../', import.meta.url);
    const emitted = new Set<string>();
    for (const folder of ['app', 'src/lib', 'src/services']) {
      for (const path of readdirSync(new URL(folder, root), { recursive: true, withFileTypes: true })) {
        if (!path.isFile() || !path.name.endsWith('.ts')) continue;
        const source = readFileSync(`${path.parentPath}/${path.name}`, 'utf8');
        for (const match of source.matchAll(/publish\('((?:event|ticket|checkin)\.[^']+)'/g)) {
          emitted.add(match[1]);
        }
      }
    }
    expect([...emitted].sort()).toEqual([...manifest.emittableEvents].sort());
    expect(manifest.emittableEvents.every((type) => /^(event|ticket|checkin)\.[a-z0-9_.]+$/.test(type))).toBe(true);
    expect(new Set(manifest.emittableEvents).size).toBe(manifest.emittableEvents.length);
  });
});
