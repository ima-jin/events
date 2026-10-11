/**
 * Tests for app/api/attending/[did]/route.ts — a thin handler over
 * `listAttendingEvents` (the privacy/merge rules are covered by the service tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ listAttendingEvents: vi.fn(), error: vi.fn() }));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));
vi.mock('@/services/guests-service', () => ({ listAttendingEvents: mocks.listAttendingEvents }));

import { GET } from '../../app/api/attending/[did]/route';
import { ServiceError } from '@/services/errors';

const DID = 'did:imajin:owner';

function call(query = '', did = encodeURIComponent(DID)) {
  const request = new NextRequest(`https://events.test/api/attending/${did}${query}`, {
    headers: { cookie: 'session=abc' },
  });
  return GET(request, { params: Promise.resolve({ did }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAttendingEvents.mockResolvedValue([]);
});

describe('GET /api/attending/[did]', () => {
  it('decodes the DID, forwards viewer_did and the caller cookie, and returns the list', async () => {
    const events = [{ eventId: 'e1', title: 'A', startDate: '2026-12-01T00:00:00.000Z', endDate: null, venue: null, imageUrl: null }];
    mocks.listAttendingEvents.mockResolvedValue(events);

    const res = await call('?viewer_did=did:imajin:viewer');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(events);
    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, 'did:imajin:viewer', 'session=abc');
  });

  it('passes a null viewer when viewer_did is absent', async () => {
    await call();

    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, null, 'session=abc');
  });

  it('maps a ServiceError to its status, message and details', async () => {
    mocks.listAttendingEvents.mockRejectedValue(new ServiceError('conflict', 'Nope', { details: { field: 'did' } }));

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Nope', field: 'did' });
  });

  it('returns a generic 500 and logs on unexpected errors', async () => {
    mocks.listAttendingEvents.mockRejectedValue(new Error('boom'));

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
    expect(mocks.error).toHaveBeenCalled();
  });
});
