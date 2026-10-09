/**
 * Tests for app/api/events/route.ts (POST create, GET list)
 *
 * POST exercises the getNodeSelf() → buildFairManifest() branches (#2000)
 * through the real handler and the real (unmocked) `buildFairManifest` from
 * the published `@ima-jin/fair`.
 *
 * Real, unmocked: @noble/ed25519 / @noble/hashes signing (fast, no network),
 * node:crypto randomBytes, buildFairManifest, the `@/db` schema tables.
 * Mocked: the kernel HTTP calls (global fetch), the drizzle `db`, the
 * domain-event publisher (`@/lib/domain-events`), the auth seams and
 * `@ima-jin/config` (`./support/route-test-support`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appAuthSuccess,
  authFailure,
  authSuccess,
  corsHeadersMock,
  getForestScopeConfigMock,
  getNodeSelfMock,
  mockLog,
  requireAppAuthMock,
  requireHardDIDMock,
  resetRouteTestMocks,
} from './support/route-test-support';
import {
  REGISTRY_NODE_SELF,
  expectDefaultShares,
  expectRegistrySourcedShares,
  fairChainOf,
  findChainRole,
} from './support/fair-manifest-assertions';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // The module-level `serviceUrl('auth')` read happens at import time.
  process.env.AUTH_SERVICE_URL = 'https://auth.events.test';

  const returningMock = vi.fn();
  const valuesMock = vi.fn((...args: unknown[]) => ({ returning: returningMock, args }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const limitMock = vi.fn();
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.orderBy = () => selectChain;
  selectChain.limit = limitMock;
  const selectMock = vi.fn(() => selectChain);
  const publishMock = vi.fn();
  return { returningMock, valuesMock, insertMock, limitMock, selectMock, publishMock };
});

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  db: { insert: mocks.insertMock, select: mocks.selectMock },
}));

vi.mock('@/lib/domain-events', () => ({
  publish: mocks.publishMock,
}));

// buildFairManifest (@ima-jin/fair) is intentionally NOT mocked.

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST, GET } from '../../app/api/events/route';
import { events, ticketTypes } from '@/db';

// ─── Helpers ────────────────────────────────────────────────────────────────

const EVENTS_URL = 'https://events.test/api/events';
const REGISTER_URL = 'https://auth.events.test/api/register';
const CREATOR_DID = 'did:imajin:creator';
const FOREST_DID = 'did:imajin:forest';
const EVENT_DID = 'did:imajin:event123';
const APP_DID_HEADER = 'x-app-did';
const APP_DID = 'did:imajin:app';
const APP_USER_DID = 'did:imajin:app-user';
const INSUFFICIENT_SCOPE = 'Insufficient scope';

const VALID_BODY = { title: 'Test Meetup', startsAt: '2026-12-01T18:00:00.000Z' };

function makePost(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function makeGet(query = '', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${EVENTS_URL}${query}`, { headers });
}

const fetchMock = vi.fn();

function jsonOk(data: unknown) {
  return { ok: true, json: async () => data };
}

function lastInsertedValues(): Record<string, unknown> | undefined {
  return mocks.valuesMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  resetRouteTestMocks();
  vi.clearAllMocks();
  fetchMock.mockReset().mockResolvedValue(jsonOk({ did: EVENT_DID }));
  vi.stubGlobal('fetch', fetchMock);
  mocks.publishMock.mockReset().mockResolvedValue({});
  mocks.returningMock.mockReset().mockImplementation(async () => [lastInsertedValues()].flat());
  requireHardDIDMock.mockResolvedValue(authSuccess(CREATOR_DID));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── POST ───────────────────────────────────────────────────────────────────

describe('POST /api/events (#2000: node config sourced via getNodeSelf())', () => {
  it('uses the registry-sourced fee config in the persisted .fair manifest', async () => {
    getNodeSelfMock.mockResolvedValue(REGISTRY_NODE_SELF);

    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(201);
    expect(getNodeSelfMock).toHaveBeenCalled();

    expectRegistrySourcedShares(fairChainOf(await res.json()));
  });

  it('falls back to .fair defaults when the registry is unavailable (getNodeSelf() → null)', async () => {
    getNodeSelfMock.mockResolvedValue(null);

    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(201);

    expectDefaultShares(fairChainOf(await res.json()));
  });

  it('does not look up a forest scope fee, and emits no scope entry, without an act-as claim', async () => {
    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(201);

    expect(getForestScopeConfigMock).not.toHaveBeenCalled();
    expect(findChainRole(fairChainOf(await res.json()), 'scope')).toBeUndefined();
  });

  it('applies the forest scope fee (#2001) when the token carries a verified act-as claim', async () => {
    requireHardDIDMock.mockResolvedValue({ identity: { ...authSuccess(CREATOR_DID).identity, actingAs: FOREST_DID } });
    getForestScopeConfigMock.mockResolvedValue({ scopeFeeBps: 150 });

    const res = await POST(makePost(VALID_BODY));
    expect(res.status).toBe(201);

    expect(getForestScopeConfigMock).toHaveBeenCalledWith(FOREST_DID);
    expect(findChainRole(fairChainOf(await res.json()), 'scope')).toMatchObject({ did: FOREST_DID });
  });
});

describe('POST /api/events — creation', () => {
  it('persists a draft event owned by the creator and returns the signing keypair', async () => {
    const res = await POST(makePost({ ...VALID_BODY, description: 'Hello', tags: ['a'] }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mocks.insertMock).toHaveBeenCalledWith(events);
    expect(body.event).toMatchObject({
      did: EVENT_DID,
      creatorDid: CREATOR_DID,
      title: 'Test Meetup',
      description: 'Hello',
      tags: ['a'],
      status: 'draft',
      eventType: 'event',
      nameDisplayPolicy: 'attendee_choice',
      chatEnabled: true,
      locationType: 'physical',
      isVirtual: false,
    });
    expect(body.event.id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(body.eventKeypair.publicKey).toBe(body.event.publicKey);
    expect(body.eventKeypair.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ticketTypes).toEqual([]);
  });

  it('registers the event DID with the kernel auth service using a signed payload', async () => {
    await POST(makePost(VALID_BODY));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(REGISTER_URL);
    expect(init.method).toBe('POST');
    const registration = JSON.parse(init.body);
    expect(registration).toMatchObject({ scope: 'actor', subtype: 'event', name: 'Test Meetup' });
    expect(registration.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(registration.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('creates the provided ticket types for the new event', async () => {
    const res = await POST(
      makePost({
        ...VALID_BODY,
        tickets: [
          { name: 'General', price: 2000, quantity: 50, currency: 'CAD' },
          { name: 'VIP', price: 5000, quantity: 5 },
        ],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mocks.insertMock).toHaveBeenCalledWith(ticketTypes);
    expect(body.ticketTypes).toHaveLength(2);
    expect(body.ticketTypes[0]).toMatchObject({ eventId: body.event.id, name: 'General', currency: 'CAD', perks: [] });
    expect(body.ticketTypes[1]).toMatchObject({ name: 'VIP', currency: 'USD' });
  });

  it('stores campaign fields only for campaign events', async () => {
    const res = await POST(
      makePost({ ...VALID_BODY, eventType: 'campaign', targetAmount: 100000, deadline: '2026-11-01T00:00:00.000Z' }),
    );
    const { event } = await res.json();

    expect(res.status).toBe(201);
    expect(event).toMatchObject({ eventType: 'campaign', targetAmount: 100000 });
    expect(event.deadline).toBe('2026-11-01T00:00:00.000Z');
  });

  it('publishes event.create and event.created domain events for the creator', async () => {
    const res = await POST(makePost(VALID_BODY));
    const { event } = await res.json();

    expect(mocks.publishMock).toHaveBeenCalledWith(
      'event.create',
      expect.objectContaining({ issuer: CREATOR_DID, scope: 'events', payload: expect.objectContaining({ eventId: event.id }) }),
    );
    expect(mocks.publishMock).toHaveBeenCalledWith(
      'event.created',
      expect.objectContaining({
        issuer: CREATOR_DID,
        payload: expect.objectContaining({ context_id: event.id, context_type: 'event' }),
      }),
    );
  });

  it('still returns 201 and logs when publishing fails', async () => {
    mocks.publishMock.mockRejectedValue(new Error('bus down'));

    const res = await POST(makePost(VALID_BODY));

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled());
  });

  it('creates the event chat and syncs its name policy when a chat service is configured', async () => {
    vi.stubEnv('CHAT_SERVICE_URL', 'https://chat.events.test');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:events-app');

    const res = await POST(makePost({ ...VALID_BODY, nameDisplayPolicy: 'real_names' }));

    expect(res.status).toBe(201);
    const chatCalls = fetchMock.mock.calls.filter(([url]) => new URL(String(url)).origin === 'https://chat.events.test');
    expect(chatCalls.map(([url, init]) => [url, init.method])).toEqual([
      [`https://chat.events.test/api/d/${encodeURIComponent(EVENT_DID)}/members`, 'POST'],
      [`https://chat.events.test/api/d/${encodeURIComponent(EVENT_DID)}/context`, 'PATCH'],
    ]);
    expect(JSON.parse(chatCalls[0][1].body)).toEqual({ memberDid: CREATOR_DID, role: 'admin' });
    expect(JSON.parse(chatCalls[1][1].body)).toEqual({ context: { nameDisplayPolicy: 'real_names' } });
    expect(chatCalls[1][1].headers['X-App-DID']).toBe('did:imajin:events-app');
  });

  it('does not fail event creation when the chat service is unreachable', async () => {
    vi.stubEnv('CHAT_SERVICE_URL', 'https://chat.events.test');
    fetchMock.mockImplementation(async (url: string) => {
      if (url === REGISTER_URL) return jsonOk({ did: EVENT_DID });
      throw new Error('ECONNREFUSED');
    });

    const res = await POST(makePost(VALID_BODY));

    expect(res.status).toBe(201);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('POST /api/events — validation and auth', () => {
  it.each([
    ['title', { startsAt: VALID_BODY.startsAt }, 'title is required'],
    ['startsAt', { title: VALID_BODY.title }, 'startsAt is required'],
    ['campaign target (missing)', { ...VALID_BODY, eventType: 'campaign' }, 'targetAmount must be a positive integer (cents)'],
    ['campaign target (fractional)', { ...VALID_BODY, eventType: 'campaign', targetAmount: 10.5 }, 'targetAmount must be a positive integer (cents)'],
    ['campaign target (negative)', { ...VALID_BODY, eventType: 'campaign', targetAmount: -1 }, 'targetAmount must be a positive integer (cents)'],
  ])('rejects an invalid body with 400 (%s) before any side effect', async (_label, body, message) => {
    const res = await POST(makePost(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getNodeSelfMock).not.toHaveBeenCalled();
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('passes through the auth failure (soft DIDs are rejected with 403) without creating anything', async () => {
    requireHardDIDMock.mockResolvedValue(authFailure(403, 'This action requires a full identity (hard DID)'));

    const res = await POST(makePost(VALID_BODY));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This action requires a full identity (hard DID)' });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('authenticates with app auth (events:write) when x-app-did is present and creates for the app user', async () => {
    requireAppAuthMock.mockResolvedValue(appAuthSuccess(APP_USER_DID, ['events:write']));

    const request = makePost(VALID_BODY, { [APP_DID_HEADER]: APP_DID });
    const res = await POST(request);
    const { event } = await res.json();

    expect(res.status).toBe(201);
    expect(requireAppAuthMock).toHaveBeenCalledWith(request, { scope: 'events:write' });
    expect(requireHardDIDMock).not.toHaveBeenCalled();
    expect(event.creatorDid).toBe(APP_USER_DID);
  });

  it('returns the app-auth error status when the app token is rejected', async () => {
    corsHeadersMock.mockReturnValue({ 'access-control-allow-origin': '*' });
    requireAppAuthMock.mockResolvedValue({ error: INSUFFICIENT_SCOPE, status: 403 });

    const res = await POST(makePost(VALID_BODY, { [APP_DID_HEADER]: APP_DID }));

    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: INSUFFICIENT_SCOPE });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the kernel rejects the event DID registration', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'bad signature' }) });

    const res = await POST(makePost(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to register event DID: bad signature' });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when persisting the event fails', async () => {
    mocks.returningMock.mockRejectedValue(new Error('insert failed'));

    const res = await POST(makePost(VALID_BODY));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create event' });
    expect(mockLog.error).toHaveBeenCalled();
    expect(mocks.publishMock).not.toHaveBeenCalled();
  });
});

// ─── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/events', () => {
  const EVENT_ROW = {
    id: 'evt_1',
    did: EVENT_DID,
    creatorDid: CREATOR_DID,
    title: 'Listed',
    status: 'published',
    privateKey: 'secret',
    emtEmail: 'emt@example.com',
  };

  it('lists events for anonymous callers', async () => {
    mocks.limitMock.mockResolvedValue([EVENT_ROW]);

    const res = await GET(makeGet('?upcoming=true&limit=5'));

    expect(res.status).toBe(200);
    const { events } = await res.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: EVENT_ROW.id, title: 'Listed' });
    // The ticket-signing key must never leave the server on a read route (deviation from the kernel).
    expect(events[0]).not.toHaveProperty('privateKey');
  });

  it('restricts app-auth callers to the public event fields', async () => {
    requireAppAuthMock.mockResolvedValue(appAuthSuccess(APP_USER_DID));
    mocks.limitMock.mockResolvedValue([EVENT_ROW]);

    const request = makeGet('', { [APP_DID_HEADER]: APP_DID });
    const res = await GET(request);
    const { events: listed } = await res.json();

    expect(requireAppAuthMock).toHaveBeenCalledWith(request, { scope: 'events:read' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'evt_1', title: 'Listed' });
    expect(listed[0]).not.toHaveProperty('privateKey');
    expect(listed[0]).not.toHaveProperty('emtEmail');
  });

  it('returns the app-auth error status when the app token is rejected', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'Invalid app token', status: 401 });

    const res = await GET(makeGet('', { [APP_DID_HEADER]: APP_DID }));

    expect(res.status).toBe(401);
    expect(mocks.selectMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the listing query fails', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));

    const res = await GET(makeGet());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list events' });
  });
});
