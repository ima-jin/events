/**
 * Tests for app/api/attending/[did]/route.ts — a thin handler over
 * `listAttendingEvents` (the privacy/merge rules are covered by the service tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ listAttendingEvents: vi.fn(), optionalAuth: vi.fn(), error: vi.fn() }));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));
vi.mock('@/services/guests-service', () => ({ listAttendingEvents: mocks.listAttendingEvents }));
vi.mock('@/lib/auth', () => ({ optionalAuth: mocks.optionalAuth }));

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
  mocks.optionalAuth.mockResolvedValue(null);
});

describe('GET /api/attending/[did]', () => {
  it('decodes the DID, authenticates the caller, and ignores a spoofed viewer_did', async () => {
    const events = [{ eventId: 'e1', title: 'A', startDate: '2026-12-01T00:00:00.000Z', endDate: null, venue: null, imageUrl: null }];
    mocks.listAttendingEvents.mockResolvedValue(events);
    mocks.optionalAuth.mockResolvedValue({ id: 'did:imajin:session-viewer' });

    const res = await call('?viewer_did=did:imajin:viewer');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(events);
    expect(mocks.optionalAuth).toHaveBeenCalledWith(expect.any(NextRequest));
    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, 'did:imajin:session-viewer');
  });

  it('passes a null viewer for anonymous callers even when viewer_did spoofs the owner', async () => {
    await call(`?viewer_did=${encodeURIComponent(DID)}`);

    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, null);
  });

  it('passes the authenticated owner DID even without a viewer_did query', async () => {
    mocks.optionalAuth.mockResolvedValue({ id: DID });
    await call();
    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, DID);
  });

  it('never substitutes an act-as or delegated DID for the authenticated caller', async () => {
    mocks.optionalAuth.mockResolvedValue({ id: 'did:other', actingAs: DID, actingFor: DID });
    await call(`?viewer_did=${encodeURIComponent(DID)}`);
    expect(mocks.listAttendingEvents).toHaveBeenCalledWith(DID, 'did:other');
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
