/**
 * Tests for app/api/events/[id]/tiers/route.ts (GET / POST / PUT).
 *
 * The handlers are thin: authenticate, call `@/services/ticket-types-service`,
 * map `ServiceError` onto the JSON response. The service is mocked here (its
 * rules are covered in services/ticket-types-service.test.ts); these tests pin
 * the HTTP contract: auth failures, every status code, the legacy `x-app-did`
 * path and its CORS headers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ORGANIZER_DID,
  makeTier,
  nextCacheMock,
  resetTiersServiceMocks,
  tiersServiceMock as service,
} from './support/ticket-types-support';
import {
  appAuthSuccess,
  authFailure,
  authSuccess,
  corsHeadersMock,
  mockLog,
  requireAppAuthMock,
  requireAuthMock,
  resetRouteTestMocks,
} from './support/route-test-support';

vi.mock('@/services/ticket-types-service', async () => (await import('./support/ticket-types-support')).tiersServiceMock);
vi.mock('next/cache', async () => (await import('./support/ticket-types-support')).nextCacheMock);

import { ServiceError } from '@/services/errors';
import { GET, POST, PUT } from '../../app/api/events/[id]/tiers/route';

const PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };
const CORS = { 'access-control-allow-origin': 'https://app.test' };

function makeRequest(method: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest('http://localhost/api/events/evt_1/tiers', { method, ...init });
}

const jsonRequest = (method: string, body: unknown) =>
  makeRequest(method, { body: JSON.stringify(body), headers: { cookie: 'session=abc' } });

beforeEach(() => {
  resetRouteTestMocks();
  resetTiersServiceMocks();
  corsHeadersMock.mockReturnValue(CORS);
});

describe('GET /tiers', () => {
  it('lists public tiers for an anonymous caller, without CORS headers', async () => {
    service.listPublicTiers.mockResolvedValue([{ ...makeTier(), available: 90 }]);

    const res = await GET(makeRequest('GET'), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).tiers).toHaveLength(1);
    expect(service.listPublicTiers).toHaveBeenCalledWith('evt_1');
    expect(requireAppAuthMock).not.toHaveBeenCalled();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers 500 and logs when listing fails', async () => {
    service.listPublicTiers.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest('GET'), PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list tiers' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: db down' }, 'Failed to list tiers');
  });

  describe('legacy x-app-did path', () => {
    const appRequest = () => makeRequest('GET', { headers: { 'x-app-did': 'did:imajin:app' } });

    it('requires events:read and echoes the auth failure with CORS headers', async () => {
      requireAppAuthMock.mockResolvedValue({ error: 'Invalid app token', status: 401 });

      const res = await GET(appRequest(), PARAMS);

      expect(requireAppAuthMock).toHaveBeenCalledWith(expect.anything(), { scope: 'events:read' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid app token' });
      expect(res.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin']);
      expect(service.listPublicTiers).not.toHaveBeenCalled();
    });

    it('lists tiers with CORS headers once authorized', async () => {
      requireAppAuthMock.mockResolvedValue(appAuthSuccess('did:imajin:user'));
      service.listPublicTiers.mockResolvedValue([{ ...makeTier(), available: null }]);

      const res = await GET(appRequest(), PARAMS);

      expect(res.status).toBe(200);
      expect((await res.json()).tiers[0].available).toBeNull();
      expect(res.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin']);
    });

    it('answers 500 with CORS headers and an app-auth log line when listing fails', async () => {
      requireAppAuthMock.mockResolvedValue(appAuthSuccess('did:imajin:user'));
      service.listPublicTiers.mockRejectedValue(new Error('db down'));

      const res = await GET(appRequest(), PARAMS);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to list tiers' });
      expect(res.headers.get('access-control-allow-origin')).toBe(CORS['access-control-allow-origin']);
      expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: db down' }, 'Failed to list tiers (app auth)');
    });
  });
});

describe.each([
  { method: 'POST', handler: POST, failure: 'Failed to create tier', call: service.createTier },
  { method: 'PUT', handler: PUT, failure: 'Failed to update tier', call: service.updateTier },
])('$method /tiers — shared write contract', ({ method, handler, failure, call }) => {
  it('relays the auth failure', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await handler(jsonRequest(method, {}), PARAMS);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(call).not.toHaveBeenCalled();
  });

  it('passes the acting DID, event, caller cookie and a lazy body reader to the service', async () => {
    call.mockResolvedValue({ tier: makeTier(), changed: true });
    requireAuthMock.mockResolvedValue(authSuccess(ORGANIZER_DID));

    await handler(jsonRequest(method, { name: 'VIP' }), PARAMS);

    const input = call.mock.calls[0][0];
    expect(input).toMatchObject({ eventId: 'evt_1', actorDid: ORGANIZER_DID, callerCookie: 'session=abc' });
    expect(await input.readBody()).toEqual({ name: 'VIP' });
  });

  it('maps a ServiceError to its pinned status and message', async () => {
    call.mockRejectedValue(new ServiceError('forbidden', 'Not authorized'));

    const res = await handler(jsonRequest(method, {}), PARAMS);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized' });
    expect(nextCacheMock.revalidatePath).not.toHaveBeenCalled();
  });

  it('answers 500 and logs on an unexpected failure', async () => {
    call.mockRejectedValue(new Error('boom'));

    const res = await handler(jsonRequest(method, {}), PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: failure });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, failure);
  });
});

describe('POST /tiers', () => {
  it('creates a tier, revalidates the event page and answers 201', async () => {
    const tier = makeTier({ name: 'VIP' });
    service.createTier.mockResolvedValue(tier);

    const res = await POST(jsonRequest('POST', { name: 'VIP', price: 100 }), PARAMS);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ tier: JSON.parse(JSON.stringify(tier)) });
    expect(nextCacheMock.revalidatePath).toHaveBeenCalledWith('/evt_1');
  });

  it.each([
    [400, 'name is required'],
    [400, 'price must be >= 0'],
  ])('relays validation errors (%i %s)', async (status, message) => {
    service.createTier.mockRejectedValue(new ServiceError('invalid', message));

    const res = await POST(jsonRequest('POST', {}), PARAMS);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });
});

describe('PUT /tiers', () => {
  it('updates a tier, revalidates the event page and answers 200', async () => {
    service.updateTier.mockResolvedValue({ tier: { ...makeTier(), available: 90 }, changed: true });

    const res = await PUT(jsonRequest('PUT', { tierId: 'tkt_type_1', name: 'x' }), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).tier.available).toBe(90);
    expect(nextCacheMock.revalidatePath).toHaveBeenCalledWith('/evt_1');
  });

  it('answers "No changes" without revalidating when nothing was written', async () => {
    service.updateTier.mockResolvedValue({ tier: makeTier(), changed: false });

    const res = await PUT(jsonRequest('PUT', { tierId: 'tkt_type_1' }), PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('No changes');
    expect(body.tier.id).toBe('tkt_type_1');
    expect(nextCacheMock.revalidatePath).not.toHaveBeenCalled();
  });

  it('spreads append-only violations into the 400 body', async () => {
    service.updateTier.mockRejectedValue(
      new ServiceError('invalid', 'Append-only policy violation', { details: { violations: ['quantity too low'] } }),
    );

    const res = await PUT(jsonRequest('PUT', { tierId: 'tkt_type_1' }), PARAMS);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Append-only policy violation', violations: ['quantity too low'] });
  });

  it.each([
    [400, 'invalid', 'tierId is required'],
    [404, 'not_found', 'Tier not found'],
  ] as const)('relays %i for "%s"', async (status, code, message) => {
    service.updateTier.mockRejectedValue(new ServiceError(code, message));

    const res = await PUT(jsonRequest('PUT', {}), PARAMS);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });
});
