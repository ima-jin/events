/**
 * Tests for app/api/events/[id]/cohosts/route.ts (GET/POST)
 *
 * #2155: this route reads/writes pod membership through the kernel
 * connections service's `GET /api/pods/{id}` and `POST /api/pods/{id}/members`
 * routes (public kernel HTTP API), forwarding the caller's session cookie,
 * and resolves profiles through the kernel auth service's `/api/lookup/{did}`.
 * Service base URLs come from env (`CONNECTIONS_SERVICE_URL`,
 * `AUTH_SERVICE_URL`, `CHAT_SERVICE_URL`) via `serviceUrl()`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  authServiceUrl,
  connectionsServiceUrl,
  fakeResponse,
  fetchMock,
  logMock,
  makeRequest,
  nextSelect,
  requireAuthMock,
  resetTicketRouteMocks,
  selectMock,
  ERR_EVENT_NOT_FOUND,
  ERR_UNAUTHORIZED,
  itReturns401WhenAuthFails,
} from '@/__tests__/support/ticket-route-support';
import { GET, POST } from '../route';

// `@/lib/cohost-helpers` resolves handle → DID via the profile service; it has its own seam here.
const resolveCoHostDidMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/cohost-helpers', () => ({ resolveCoHostDid: resolveCoHostDidMock }));

const OWNER_DID = 'did:imajin:owner';
const COHOST1_DID = 'did:imajin:cohost1';
const JOINED_AT = '2026-01-01T00:00:00Z';
const NEW_JOINED_AT = '2026-03-01T00:00:00Z';
const AVATAR_URL = 'https://cdn.test/a.png';
const ERR_ADD_COHOST = 'Failed to add cohost';
const COHOSTS_PATH = '/api/events/evt_1/cohosts';
const NEW_COHOST_DID = 'did:imajin:newcohost';
const EVENT_DID = 'did:imajin:event';
const CHAT_ENV = 'CHAT_SERVICE_URL';
const CHAT_URL = 'https://chat.test';
const POD_URL = `${connectionsServiceUrl}/api/pods/pod_1`;
const ROUTE_PARAMS = { params: Promise.resolve({ id: 'evt_1' }) };
const EVENT_ROW = { id: 'evt_1', podId: 'pod_1', creatorDid: OWNER_DID, did: EVENT_DID };
const ERR_ADD_MEMBER_FORBIDDEN = 'Only the owner can add members';

const callGet = () => GET(makeRequest(COHOSTS_PATH, 'GET'), ROUTE_PARAMS);
const callPost = (body: Record<string, unknown>) =>
  POST(makeRequest(COHOSTS_PATH, 'POST', body), ROUTE_PARAMS);

function podMember(did: string, overrides: Record<string, unknown> = {}) {
  return {
    podId: 'pod_1',
    did,
    role: 'cohost',
    addedBy: OWNER_DID,
    joinedAt: JOINED_AT,
    removedAt: null,
    ...overrides,
  };
}

type Outcome = Response | Error;

interface KernelStub {
  /** GET /connections/api/pods/{id} */
  pod?: Outcome;
  /** POST /connections/api/pods/{id}/members */
  add?: Outcome;
  /** GET /auth/api/lookup/{did} */
  lookup?: Outcome;
  /** POST {chat}/api/d/{did}/members */
  chat?: Outcome;
}

/** Route `fetch` by URL; an `Error` outcome rejects, an unconfigured route answers 200 `{}`. */
function stubKernel(stub: KernelStub = {}): void {
  const routes: [string, Outcome | undefined][] = [
    ['/api/pods/pod_1/members', stub.add],
    ['/api/pods/pod_1', stub.pod],
    ['/api/lookup/', stub.lookup],
    ['/api/d/', stub.chat],
  ];
  fetchMock.mockImplementation((url: string) => {
    const outcome = routes.find(([fragment]) => String(url).includes(fragment))?.[1] ?? fakeResponse(200, {});
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
}

/** URLs of every `fetch` call so far. */
const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

/** The `fetch` call whose URL contains `fragment`. */
const fetchCall = (fragment: string) => fetchMock.mock.calls.find(([url]) => String(url).includes(fragment));

beforeEach(() => {
  resetTicketRouteMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: OWNER_DID, scopes: [], via: 'token' } });
  resolveCoHostDidMock.mockReset();
  resolveCoHostDidMock.mockResolvedValue({
    coHostDid: NEW_COHOST_DID,
    profileData: { name: 'New Cohost', handle: 'newcohost' },
  });
});

describe('GET /api/events/[id]/cohosts — kernel pods API (#2155)', () => {
  it('fetches pod members from the kernel connections service, forwarding the cookie', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: fakeResponse(200, { pod: { id: 'pod_1' }, members: [podMember(COHOST1_DID)] }) });

    const res = await callGet();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cohosts).toHaveLength(1);
    expect(json.cohosts[0]).toMatchObject({ did: COHOST1_DID, role: 'cohost', addedAt: JOINED_AT });

    const podCall = fetchCall('/api/pods/pod_1');
    expect(podCall?.[0]).toBe(POD_URL);
    expect(podCall?.[1]?.headers).toMatchObject({ cookie: 'session=abc' });
  });

  it('resolves each cohost profile through the kernel auth service', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({
      pod: fakeResponse(200, { members: [podMember(COHOST1_DID)] }),
      lookup: fakeResponse(200, { identity: { name: 'Co Host', handle: 'cohost', avatarUrl: AVATAR_URL } }),
    });

    const json = await (await callGet()).json();

    expect(fetchedUrls()).toContain(`${authServiceUrl}/api/lookup/${encodeURIComponent(COHOST1_DID)}`);
    expect(json.cohosts[0]).toMatchObject({
      did: COHOST1_DID,
      name: 'Co Host',
      handle: 'cohost',
      avatar: AVATAR_URL,
    });
  });

  it('lists cohosts oldest-first', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({
      pod: fakeResponse(200, {
        members: [
          podMember('did:imajin:later', { joinedAt: NEW_JOINED_AT }),
          podMember('did:imajin:earlier', { joinedAt: JOINED_AT }),
        ],
      }),
    });

    const json = await (await callGet()).json();

    expect(json.cohosts.map((c: { did: string }) => c.did)).toEqual(['did:imajin:earlier', 'did:imajin:later']);
  });

  it('filters out non-cohost members and removed members', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({
      pod: fakeResponse(200, {
        members: [
          podMember('did:imajin:owner-member', { role: 'owner', addedBy: null, joinedAt: '2026-01-01' }),
          podMember('did:imajin:removed', { addedBy: null, joinedAt: '2026-01-01', removedAt: '2026-02-01' }),
        ],
      }),
    });

    const json = await (await callGet()).json();

    expect(json.cohosts).toHaveLength(0);
  });

  it('returns cohosts: [] without calling the connections service when the event has no pod', async () => {
    nextSelect([{ ...EVENT_ROW, podId: null }]);

    const json = await (await callGet()).json();

    expect(json.cohosts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the event is not found', async () => {
    nextSelect([]);

    const res = await callGet();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_EVENT_NOT_FOUND });
  });

  it('does not require authentication (public cohost list)', async () => {
    requireAuthMock.mockResolvedValue({ error: ERR_UNAUTHORIZED, status: 401 });
    nextSelect([{ ...EVENT_ROW, podId: null }]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(requireAuthMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unreachable', new Error('network error')],
    ['non-2xx', fakeResponse(503, {})],
  ])('fails soft to an empty list when the connections service is %s', async (_label, outcome) => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: outcome });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect((await res.json()).cohosts).toEqual([]);
  });

  it.each([
    ['unreachable', new Error('auth service down')],
    ['non-2xx', fakeResponse(500, {})],
  ])('returns null profile fields when the auth lookup service is %s', async (_label, outcome) => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: fakeResponse(200, { members: [podMember(COHOST1_DID)] }), lookup: outcome });

    const json = await (await callGet()).json();

    expect(json.cohosts[0]).toMatchObject({ did: COHOST1_DID, name: null, handle: null, avatar: null });
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callGet();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list cohosts' });
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('POST /api/events/[id]/cohosts — kernel pods API (#2155)', () => {
  itReturns401WhenAuthFails(() => callPost({ did: NEW_COHOST_DID }));

  it('adds a new cohost via the kernel pods/members endpoint, forwarding the cookie', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({
      pod: fakeResponse(200, { members: [] }),
      add: fakeResponse(201, { member: podMember(NEW_COHOST_DID, { joinedAt: NEW_JOINED_AT }) }),
    });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(201);
    expect((await res.json()).cohost).toEqual({
      did: NEW_COHOST_DID,
      name: 'New Cohost',
      handle: 'newcohost',
      avatar: null,
      role: 'cohost',
      addedAt: NEW_JOINED_AT,
    });

    const addCall = fetchCall('/members');
    expect(addCall?.[0]).toBe(`${POD_URL}/members`);
    expect(addCall?.[1]).toMatchObject({ method: 'POST', headers: { cookie: 'session=abc' } });
    expect(JSON.parse(addCall?.[1]?.body as string)).toEqual({ did: NEW_COHOST_DID, role: 'cohost' });
    expect(resolveCoHostDidMock).toHaveBeenCalledWith(NEW_COHOST_DID, undefined);
  });

  it('derives the handle from the request (minus "@") and the avatar from the profile when the resolver omits them', async () => {
    nextSelect([EVENT_ROW]);
    resolveCoHostDidMock.mockResolvedValue({ coHostDid: NEW_COHOST_DID, profileData: { avatarUrl: AVATAR_URL } });
    stubKernel({
      pod: fakeResponse(200, { members: [] }),
      add: fakeResponse(201, { member: podMember(NEW_COHOST_DID) }),
    });

    const json = await (await callPost({ handle: '@newcohost' })).json();

    expect(resolveCoHostDidMock).toHaveBeenCalledWith(undefined, '@newcohost');
    expect(json.cohost).toMatchObject({ name: null, handle: 'newcohost', avatar: AVATAR_URL });
  });

  it('is idempotent: re-adding an existing cohost succeeds without calling the kernel insert route', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: fakeResponse(200, { members: [podMember(NEW_COHOST_DID)] }) });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(201);
    expect((await res.json()).cohost.addedAt).toBe(JOINED_AT);
    expect(fetchCall('/members')).toBeUndefined();
  });

  it('returns 403 when the caller is not the event owner', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else', scopes: [], via: 'token' } });
    nextSelect([EVENT_ROW]);

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only the event owner can add cohosts' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a kernel error when adding the member fails', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({
      pod: fakeResponse(200, { members: [] }),
      add: fakeResponse(403, { error: ERR_ADD_MEMBER_FORBIDDEN }),
    });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(ERR_ADD_MEMBER_FORBIDDEN);
  });

  it('falls back to a generic message when the kernel error has no body message', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: fakeResponse(200, { members: [] }), add: fakeResponse(500, {}) });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(ERR_ADD_COHOST);
  });

  it('returns a 502 when the connections service is unreachable while adding the member', async () => {
    nextSelect([EVENT_ROW]);
    stubKernel({ pod: fakeResponse(200, { members: [] }), add: new Error('network down') });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Failed to reach connections service');
  });

  it('returns 404 when the event is not found', async () => {
    nextSelect([]);

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(404);
  });

  it('returns 500 when the event pod is not initialized', async () => {
    nextSelect([{ ...EVENT_ROW, podId: null }]);

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Event pod not initialized');
  });

  it('returns 400 when neither did nor handle is provided', async () => {
    nextSelect([EVENT_ROW]);

    const res = await callPost({});

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('did or handle is required');
    expect(resolveCoHostDidMock).not.toHaveBeenCalled();
  });

  it('propagates an error resolving the cohost target (e.g. handle not found)', async () => {
    nextSelect([EVENT_ROW]);
    resolveCoHostDidMock.mockResolvedValue({ error: 'Handle not found', status: 404 });

    const res = await callPost({ handle: '@nobody' });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Handle not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the caller tries to add themselves as cohost', async () => {
    nextSelect([EVENT_ROW]);
    resolveCoHostDidMock.mockResolvedValue({ coHostDid: OWNER_DID, profileData: {} });

    const res = await callPost({ did: OWNER_DID });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Cannot add yourself as cohost');
  });

  it('returns 500 when the request body is not valid JSON', async () => {
    nextSelect([EVENT_ROW]);
    const request = makeRequest(COHOSTS_PATH, 'POST');

    const res = await POST(request, ROUTE_PARAMS);

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(ERR_ADD_COHOST);
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callPost({ did: NEW_COHOST_DID });

    expect(res.status).toBe(500);
    expect(logMock.error).toHaveBeenCalled();
  });

  describe('chat sync (non-fatal)', () => {
    const queueNewCohost = () => {
      nextSelect([EVENT_ROW]);
      return {
        pod: fakeResponse(200, { members: [] }),
        add: fakeResponse(201, { member: podMember(NEW_COHOST_DID, { joinedAt: NEW_JOINED_AT }) }),
      };
    };

    it('syncs the new cohost to the event chat when CHAT_SERVICE_URL is configured', async () => {
      vi.stubEnv(CHAT_ENV, CHAT_URL);
      stubKernel(queueNewCohost());

      const res = await callPost({ did: NEW_COHOST_DID });

      expect(res.status).toBe(201);
      const chatCall = fetchCall('/api/d/');
      expect(chatCall?.[0]).toBe(`${CHAT_URL}/api/d/${encodeURIComponent(EVENT_DID)}/members`);
      expect(JSON.parse(chatCall?.[1]?.body as string)).toEqual({ memberDid: NEW_COHOST_DID, role: 'admin' });
    });

    it('skips the chat sync when no chat service is configured', async () => {
      stubKernel(queueNewCohost());

      const res = await callPost({ did: NEW_COHOST_DID });

      expect(res.status).toBe(201);
      expect(fetchCall('/api/d/')).toBeUndefined();
    });

    it('skips the chat sync when the event has no DID', async () => {
      vi.stubEnv(CHAT_ENV, CHAT_URL);
      stubKernel({
        pod: fakeResponse(200, { members: [] }),
        add: fakeResponse(201, { member: podMember(NEW_COHOST_DID) }),
      });
      nextSelect([{ ...EVENT_ROW, did: null }]);

      const res = await callPost({ did: NEW_COHOST_DID });

      expect(res.status).toBe(201);
      expect(fetchCall('/api/d/')).toBeUndefined();
    });

    it('does not fail the request when the chat sync itself fails', async () => {
      vi.stubEnv(CHAT_ENV, CHAT_URL);
      stubKernel({ ...queueNewCohost(), chat: new Error('chat down') });

      const res = await callPost({ did: NEW_COHOST_DID });

      expect(res.status).toBe(201);
      expect(logMock.warn).toHaveBeenCalledWith({ err: 'Error: chat down' }, 'Cohost chat sync failed (non-fatal)');
    });
  });
});
