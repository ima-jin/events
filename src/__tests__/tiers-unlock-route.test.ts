/**
 * Tests for app/api/events/[id]/tiers/unlock/route.ts — unauthenticated, no
 * CORS, delegates to `unlockTiers` and maps its errors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { makeTier, resetTiersServiceMocks, tiersServiceMock as service } from './support/ticket-types-support';
import { mockLog, requireAuthMock, resetRouteTestMocks } from './support/route-test-support';

vi.mock('@/services/ticket-types-service', async () => (await import('./support/ticket-types-support')).tiersServiceMock);

import { ServiceError } from '@/services/errors';
import { GET } from '../../app/api/events/[id]/tiers/unlock/route';

const PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };
const unlockRequest = (query = '') => new NextRequest(`http://localhost/api/events/evt_1/tiers/unlock${query}`);

beforeEach(() => {
  resetRouteTestMocks();
  resetTiersServiceMocks();
});

describe('GET /tiers/unlock', () => {
  it('returns the tiers revealed by the code without requiring auth', async () => {
    service.unlockTiers.mockResolvedValue([{ ...makeTier({ accessCode: 'VIP' }), available: 5 }]);

    const res = await GET(unlockRequest('?code=vip'), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json()).tiers[0]).toMatchObject({ accessCode: 'VIP', available: 5 });
    expect(service.unlockTiers).toHaveBeenCalledWith('evt_1', 'vip');
    expect(requireAuthMock).not.toHaveBeenCalled();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('passes a missing code through so the service answers 400', async () => {
    service.unlockTiers.mockRejectedValue(new ServiceError('invalid', 'Missing code parameter'));

    const res = await GET(unlockRequest(), PARAMS);

    expect(service.unlockTiers).toHaveBeenCalledWith('evt_1', null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing code parameter' });
  });

  it('answers 404 for an unknown code', async () => {
    service.unlockTiers.mockRejectedValue(new ServiceError('not_found', 'Invalid access code'));

    const res = await GET(unlockRequest('?code=nope'), PARAMS);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invalid access code' });
  });

  it('answers 500 and logs on an unexpected failure', async () => {
    service.unlockTiers.mockRejectedValue(new Error('db down'));

    const res = await GET(unlockRequest('?code=vip'), PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to unlock tiers' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: db down' }, 'Failed to unlock tiers');
  });
});
