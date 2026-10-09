/**
 * HTTP behaviour of the thin event routes (`[id]`, `mine`, `by-did/[did]`) and of the
 * ServiceError → response mapping. The events service is mocked: its logic is covered
 * by `services/events-service.test.ts`; `events-create-route.test.ts` drives the
 * create/list routes through the real service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appAuthSuccess,
  authFailure,
  authSuccess,
  corsHeadersMock,
  DEFAULT_CALLER_DID,
  mockLog,
  requireAppAuthMock,
  requireAuthMock,
  resetRouteTestMocks,
} from './support/route-test-support';

const mocks = vi.hoisted(() => ({
  getEventWithTicketTypes: vi.fn(),
  updateEventStatus: vi.fn(),
  updateEvent: vi.fn(),
  listCreatorEvents: vi.fn(),
  findEventByDid: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/services/events-service', () => ({
  getEventWithTicketTypes: mocks.getEventWithTicketTypes,
  updateEventStatus: mocks.updateEventStatus,
  updateEvent: mocks.updateEvent,
  listCreatorEvents: mocks.listCreatorEvents,
  findEventByDid: mocks.findEventByDid,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { GET as getEvent, PATCH, PUT } from '../../app/api/events/[id]/route';
import { GET as getMine } from '../../app/api/events/mine/route';
import { GET as getByDid } from '../../app/api/events/by-did/[did]/route';
import { failureResponse } from '@/lib/events-route-response';
import { ServiceError } from '@/services/errors';

const BASE = 'https://events.test/api/events';
const CALLER = 'did:imajin:organizer';
const ID_CONTEXT = { params: Promise.resolve({ id: 'evt_1' }) };
const NOT_FOUND = new ServiceError('not_found', 'Event not found');
const EVENT = { id: 'evt_1', title: 'Meetup' };

function makeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRouteTestMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('GET /api/events/[id]', () => {
  it('returns the event for anonymous callers (public serialisation, no CORS headers)', async () => {
    mocks.getEventWithTicketTypes.mockResolvedValue({ event: EVENT, ticketTypes: [] });

    const res = await getEvent(makeRequest('GET', `${BASE}/evt_1`), ID_CONTEXT);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: EVENT, ticketTypes: [] });
    expect(mocks.getEventWithTicketTypes).toHaveBeenCalledWith('evt_1', 'public');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('authenticates legacy app callers (events:read) and returns the app serialisation with CORS headers', async () => {
    corsHeadersMock.mockReturnValue({ 'access-control-allow-origin': '*' });
    requireAppAuthMock.mockResolvedValue(appAuthSuccess('did:imajin:app-user'));
    mocks.getEventWithTicketTypes.mockResolvedValue({ event: EVENT, ticketTypes: [] });

    const request = makeRequest('GET', `${BASE}/evt_1`, undefined, { 'x-app-did': 'did:imajin:app' });
    const res = await getEvent(request, ID_CONTEXT);

    expect(requireAppAuthMock).toHaveBeenCalledWith(request, { scope: 'events:read' });
    expect(mocks.getEventWithTicketTypes).toHaveBeenCalledWith('evt_1', 'app');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns the app-auth error when the app token is rejected', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'Insufficient scope', status: 403 });

    const res = await getEvent(makeRequest('GET', `${BASE}/evt_1`, undefined, { 'x-app-did': 'did:imajin:app' }), ID_CONTEXT);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient scope' });
    expect(mocks.getEventWithTicketTypes).not.toHaveBeenCalled();
  });

  it('maps the service 404 to a response', async () => {
    mocks.getEventWithTicketTypes.mockRejectedValue(NOT_FOUND);

    const res = await getEvent(makeRequest('GET', `${BASE}/evt_x`), ID_CONTEXT);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });

  it('answers 500 and logs on an unexpected failure', async () => {
    mocks.getEventWithTicketTypes.mockRejectedValue(new Error('db down'));

    const res = await getEvent(makeRequest('GET', `${BASE}/evt_1`), ID_CONTEXT);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to get event' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: db down', appAuth: false }, 'Failed to get event');
  });
});

describe('PATCH /api/events/[id]', () => {
  const patch = (body: unknown = { status: 'published' }) => PATCH(makeRequest('PATCH', `${BASE}/evt_1`, body), ID_CONTEXT);

  it('changes the status and revalidates the event pages', async () => {
    requireAuthMock.mockResolvedValue(authSuccess(CALLER));
    mocks.updateEventStatus.mockResolvedValue({ ...EVENT, status: 'published' });

    const res = await patch();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { ...EVENT, status: 'published' } });
    expect(mocks.updateEventStatus).toHaveBeenCalledWith({ eventId: 'evt_1', actorDid: CALLER, status: 'published' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/evt_1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/');
  });

  it('passes the auth failure through without calling the service', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await patch();

    expect(res.status).toBe(401);
    expect(mocks.updateEventStatus).not.toHaveBeenCalled();
  });

  it.each([
    [new ServiceError('forbidden', 'Only the event creator can change status'), 403],
    [new ServiceError('invalid', 'Invalid status'), 400],
    [NOT_FOUND, 404],
  ])('maps the service error "%s" to its status', async (error, status) => {
    mocks.updateEventStatus.mockRejectedValue(error);

    const res = await patch();

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: error.message });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('answers 500 and logs on an unexpected failure', async () => {
    mocks.updateEventStatus.mockRejectedValue(new Error('boom'));

    const res = await patch();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update event status' });
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('PUT /api/events/[id]', () => {
  const put = (body: unknown = { title: 'Renamed' }, headers: Record<string, string> = {}) =>
    PUT(makeRequest('PUT', `${BASE}/evt_1`, body, headers), ID_CONTEXT);

  it('updates the event forwarding the caller cookie, then revalidates the event page', async () => {
    mocks.updateEvent.mockResolvedValue({ ...EVENT, title: 'Renamed' });

    const res = await put({ title: 'Renamed' }, { cookie: 'session=abc' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { ...EVENT, title: 'Renamed' } });
    expect(mocks.updateEvent).toHaveBeenCalledWith({
      eventId: 'evt_1',
      actorDid: DEFAULT_CALLER_DID,
      body: { title: 'Renamed' },
      callerCookie: 'session=abc',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/evt_1');
  });

  it('passes the auth failure through without calling the service', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await put();

    expect(res.status).toBe(401);
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  it.each([
    [new ServiceError('forbidden', 'Not authorized to update this event'), 403],
    [new ServiceError('invalid', 'Invalid nameDisplayPolicy', { status: 400 }), 400],
    [NOT_FOUND, 404],
  ])('maps the service error "%s" to its status', async (error, status) => {
    mocks.updateEvent.mockRejectedValue(error);

    const res = await put();

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: error.message });
  });

  it('answers 500 and logs on an unexpected failure', async () => {
    mocks.updateEvent.mockRejectedValue(new Error('boom'));

    const res = await put();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update event' });
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('GET /api/events/mine', () => {
  const mine = () => getMine(makeRequest('GET', `${BASE}/mine`));

  it('lists the caller\'s events', async () => {
    requireAuthMock.mockResolvedValue(authSuccess(CALLER));
    mocks.listCreatorEvents.mockResolvedValue([{ ...EVENT, ticketsSold: 2, revenue: 4000, statusBadge: 'live', ticketTypes: [] }]);

    const res = await mine();

    expect(res.status).toBe(200);
    expect((await res.json()).events).toHaveLength(1);
    expect(mocks.listCreatorEvents).toHaveBeenCalledWith(CALLER);
  });

  it('rejects unauthenticated callers', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await mine();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.listCreatorEvents).not.toHaveBeenCalled();
  });

  it('answers 500 and logs when the lookup fails', async () => {
    mocks.listCreatorEvents.mockRejectedValue(new Error('db down'));

    const res = await mine();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch events' });
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('GET /api/events/by-did/[did]', () => {
  const byDid = (did: string) => getByDid(makeRequest('GET', `${BASE}/by-did/${did}`), { params: Promise.resolve({ did }) });

  it('decodes the DID and returns the event summary', async () => {
    mocks.findEventByDid.mockResolvedValue({ id: 'evt_1', title: 'Meetup', did: 'did:imajin:event123' });

    const res = await byDid(encodeURIComponent('did:imajin:event123'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { id: 'evt_1', title: 'Meetup', did: 'did:imajin:event123' } });
    expect(mocks.findEventByDid).toHaveBeenCalledWith('did:imajin:event123');
  });

  it('maps the service 404 to a response', async () => {
    mocks.findEventByDid.mockRejectedValue(NOT_FOUND);

    const res = await byDid('did:none');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });

  it('answers 500 "Internal error" and logs on an unexpected failure', async () => {
    mocks.findEventByDid.mockRejectedValue(new Error('db down'));

    const res = await byDid('did:imajin:event123');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe('failureResponse', () => {
  const options = { fallback: 'Failed', log: mockLog };

  it('honours a pinned status and spreads the error details', async () => {
    const error = new ServiceError('invalid', 'Bad quantity', { status: 422, details: { field: 'quantity' } });

    const res = failureResponse(error, options);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Bad quantity', field: 'quantity' });
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('attaches the given headers to both service and unexpected failures', () => {
    const headers = { 'access-control-allow-origin': '*' };

    expect(failureResponse(NOT_FOUND, { ...options, headers }).headers.get('access-control-allow-origin')).toBe('*');
    expect(failureResponse(new Error('x'), { ...options, headers }).headers.get('access-control-allow-origin')).toBe('*');
  });
});
