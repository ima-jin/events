import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireAuth: vi.fn(),
  isEventOrganizer: vi.fn(),
  getPayAppToken: vi.fn(),
  getContactEmail: vi.fn(),
  serviceUrl: vi.fn(),
  fetch: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@/lib/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/lib/organizer', () => ({ isEventOrganizer: mocks.isEventOrganizer }));
vi.mock('@/lib/pay-app-token', () => ({ getPayAppToken: mocks.getPayAppToken }));
vi.mock('@/lib/kernel', () => ({
  serviceUrl: mocks.serviceUrl,
  getContactEmail: mocks.getContactEmail,
}));
vi.mock('@ima-jin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://events.test/events',
  eventUrl: (base: string, id: string) => `${base}/e/${id}`,
}));

import { POST } from '../../app/api/events/[id]/message/route';

function call(body: unknown = { subject: 'Update', markdown: 'See you there' }) {
  return POST(new NextRequest('https://events.test/events/api/events/evt_1/message', {
    method: 'POST', body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: 'evt_1' }) });
}

function broadcastOptions(): RequestInit {
  return mocks.fetch.mock.calls[0][1] as RequestInit;
}

function expectNoBroadcastWork() {
  expect(mocks.sql).not.toHaveBeenCalled();
  expect(mocks.getPayAppToken).not.toHaveBeenCalled();
  expect(mocks.getContactEmail).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:organizer-fixture' } });
  mocks.isEventOrganizer.mockResolvedValue({ authorized: true });
  mocks.serviceUrl.mockReturnValue('https://kernel.test/notify');
  mocks.getPayAppToken.mockResolvedValue('FAKE_APP_SERVICE_TOKEN');
  mocks.getContactEmail.mockResolvedValue('organizer@example.test');
  mocks.sql.mockResolvedValueOnce([{ title: 'Fixture event', image_url: null }])
    .mockResolvedValueOnce([{ owner_did: 'did:imajin:attendee-fixture' }]);
  mocks.fetch.mockResolvedValue(Response.json({ sent: 1, skipped: 0, errors: 0 }));
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('organizer broadcast app-service contract', () => {
  it('requires authentication before organizer checks or broadcast work', async () => {
    mocks.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await call()).status).toBe(401);
    expect(mocks.isEventOrganizer).not.toHaveBeenCalled();
    expectNoBroadcastWork();
  });

  it('rejects a non-organizer before token mint or broadcast work', async () => {
    mocks.isEventOrganizer.mockResolvedValue({ authorized: false });
    expect((await call()).status).toBe(403);
    expectNoBroadcastWork();
  });

  it('sends only the app token and resolves reply-to through the public helper', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 1, skipped: 0, errors: 0, total: 1 });
    expect(mocks.serviceUrl).toHaveBeenCalledWith('notify');
    expect(mocks.isEventOrganizer).toHaveBeenCalledWith(
      'evt_1', 'did:imajin:organizer-fixture', expect.any(NextRequest));
    expect(mocks.getContactEmail).toHaveBeenCalledWith('did:imajin:organizer-fixture');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://kernel.test/notify/api/broadcast');
    expect(broadcastOptions()).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer FAKE_APP_SERVICE_TOKEN' },
    });
    expect(new Headers(broadcastOptions().headers).has('x-webhook-secret')).toBe(false);
    expect(JSON.parse(broadcastOptions().body as string)).toMatchObject({
      scope: 'events', subject: 'Fixture event: Update',
      dids: ['did:imajin:attendee-fixture'], replyTo: 'organizer@example.test',
    });
  });

  it('fails closed when the app token cannot be minted, without leaking SDK errors', async () => {
    mocks.getPayAppToken.mockRejectedValue(new Error('FAKE_PRIVATE_FAILURE_DETAILS'));
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('FAKE_PRIVATE_FAILURE_DETAILS');
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('FAKE_PRIVATE_FAILURE_DETAILS');
  });

  it('fails closed when notify is not configured', async () => {
    mocks.serviceUrl.mockReturnValue(null);
    expect((await call()).status).toBe(503);
    expectNoBroadcastWork();
  });

  it.each([401, 403, 500])('does not retry or fall back when notify rejects with %s', async (status) => {
    mocks.fetch.mockResolvedValue(new Response('FAKE_UPSTREAM_DETAILS', { status }));
    const response = await call();
    expect(response.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.getPayAppToken).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain('FAKE_UPSTREAM_DETAILS');
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('FAKE_UPSTREAM_DETAILS');
    expect(new Headers(broadcastOptions().headers).has('x-webhook-secret')).toBe(false);
  });

  it.each(['hidden', 'unavailable'])('omits reply-to without blocking when public email is %s', async (reason) => {
    if (reason === 'hidden') mocks.getContactEmail.mockResolvedValue(null);
    if (reason === 'unavailable') mocks.getContactEmail.mockRejectedValue(new Error('fixture contact unavailable'));
    expect((await call()).status).toBe(200);
    expect(JSON.parse(broadcastOptions().body as string)).not.toHaveProperty('replyTo');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns zero for no recipients without a contact lookup or notify request', async () => {
    mocks.sql.mockReset().mockResolvedValueOnce([{ title: 'Fixture event', image_url: null }])
      .mockResolvedValueOnce([]);
    expect(await (await call()).json()).toEqual({ sent: 0, skipped: 0, errors: 0, total: 0 });
    expect(mocks.getContactEmail).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails closed on a notify network failure without retry', async () => {
    mocks.fetch.mockRejectedValue(new Error('FAKE_REQUEST_FAILURE_DETAILS'));
    expect((await call()).status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('FAKE_REQUEST_FAILURE_DETAILS');
  });
});
