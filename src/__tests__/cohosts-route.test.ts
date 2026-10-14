import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  COHOST, COOKIE, EVENT_ID, OWNER, OTHER, PARAMS, PROFILE,
  jsonResponse, memberResponse, mocks, request, resetCohostMocks,
} from './support/cohosts-support';
import { GET, POST, DELETE } from '../../app/api/events/[id]/cohosts/route';

beforeEach(resetCohostMocks);
afterEach(() => vi.unstubAllGlobals());

describe('cohost route authentication and authorization', () => {
  it.each([GET, POST, DELETE])('requires an actor before accessing the event', async (handler) => {
    mocks.actor.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const req = request();
    const response = await handler(req, PARAMS);
    expect(response.status).toBe(401);
    expect(mocks.actor).toHaveBeenCalledWith(req);
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it('lists resolved cohosts for an organizer with the caller cookie', async () => {
    const response = await GET(request(), PARAMS);
    expect(response.status).toBe(200);
    expect(mocks.organizer).toHaveBeenCalledWith(EVENT_ID, OWNER, COOKIE);
    expect(await response.json()).toMatchObject({
      cohosts: [{ did: COHOST, name: PROFILE.name, handle: PROFILE.handle, avatar: PROFILE.avatarUrl }],
    });
  });

  it('allows an authorized cohost to list but denies an outsider', async () => {
    mocks.actor.mockResolvedValue({ did: COHOST });
    mocks.organizer.mockResolvedValue({ authorized: true, role: 'cohost' });
    expect((await GET(request(), PARAMS)).status).toBe(200);
    mocks.actor.mockResolvedValue({ did: OTHER });
    mocks.organizer.mockResolvedValue({ authorized: false });
    expect((await GET(request(), PARAMS)).status).toBe(403);
  });

  it.each([POST, DELETE])('denies cohosts permission to mutate membership', async (handler) => {
    mocks.actor.mockResolvedValue({ did: COHOST });
    expect((await handler(request('POST', { did: OTHER }), PARAMS)).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('cohost route mutations and errors', () => {
  it('adds a cohost by handle and keeps the existing 201 response', async () => {
    const response = await POST(request('POST', { handle: '@cohost' }), PARAMS);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ cohost: { did: COHOST, role: 'cohost' } });
  });

  it('removes an active cohost and returns removed true', async () => {
    const response = await DELETE(request('DELETE', { did: COHOST }), PARAMS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
  });

  it.each([GET, POST, DELETE])('returns 404 when the event is missing', async (handler) => {
    mocks.event.mockResolvedValue(null);
    const response = await handler(request('POST', { did: COHOST }), PARAMS);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Event not found' });
  });

  it.each([POST, DELETE])('rejects malformed JSON as a 400', async (handler) => {
    const req = new NextRequest('https://events.test/api/events/id/cohosts', { method: 'POST', body: '{' });
    const response = await handler(req, PARAMS);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('propagates a meaningful upstream removal error', async () => {
    mocks.fetch.mockResolvedValueOnce(memberResponse()).mockResolvedValueOnce(
      jsonResponse({ error: 'Chain verification required' }, 403),
    );
    const response = await DELETE(request('DELETE', { did: COHOST }), PARAMS);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Chain verification required' });
  });

  it.each([GET, POST, DELETE])('contains unexpected repository failures', async (handler) => {
    mocks.event.mockRejectedValue(new Error('private database detail'));
    const response = await handler(request('POST', { did: COHOST }), PARAMS);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private database detail');
  });
});
