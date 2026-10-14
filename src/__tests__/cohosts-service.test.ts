import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  COHOST, COOKIE, EVENT, EVENT_ID, MEMBER, OWNER, OTHER, POD_ID,
  jsonResponse, memberResponse, mocks, resetCohostMocks,
} from './support/cohosts-support';
import { addEventCohost, listEventCohosts, removeEventCohost } from '@/services/cohosts-service';

beforeEach(resetCohostMocks);
afterEach(() => vi.unstubAllGlobals());

const list = (did = OWNER) => listEventCohosts(EVENT_ID, did, COOKIE);
const add = (body: unknown = { did: COHOST }, did = OWNER) => addEventCohost(EVENT_ID, did, body, COOKIE);
const remove = (body: unknown = { did: COHOST }, did = OWNER) => removeEventCohost(EVENT_ID, did, body, COOKIE);
const membershipUrl = `https://connections.test/api/pods/${encodeURIComponent(POD_ID)}`;

describe('organizer-only list', () => {
  it.each(['creator', 'cohost'])('accepts an authorized %s', async (role) => {
    mocks.organizer.mockResolvedValue({ authorized: true, role });
    expect((await list()).cohosts).toHaveLength(1);
    expect(mocks.organizer).toHaveBeenCalledWith(EVENT_ID, OWNER, COOKIE);
    expect(mocks.fetch).toHaveBeenCalledWith(membershipUrl, { headers: { cookie: COOKIE }, cache: 'no-store' });
  });

  it('denies nonorganizers without listing members', async () => {
    mocks.organizer.mockResolvedValue({ authorized: false });
    await expect(list(OTHER)).rejects.toMatchObject({ status: 403 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('returns empty for a creator whose event has no pod', async () => {
    mocks.event.mockResolvedValue({ ...EVENT, podId: null });
    expect(await list()).toEqual({ cohosts: [] });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('filters removed and other-role members and sorts oldest first', async () => {
    const early = { ...MEMBER, did: OTHER, joinedAt: '2026-10-13T12:00:00Z' };
    mocks.fetch.mockResolvedValueOnce(memberResponse([
      MEMBER, early, { ...MEMBER, role: 'owner' }, { ...MEMBER, removedAt: '2026-10-14T13:00:00Z' },
    ]));
    expect((await list()).cohosts.map((cohost) => cohost.did)).toEqual([OTHER, COHOST]);
  });

  it('keeps listing when profile lookup fails', async () => {
    mocks.fetch.mockResolvedValueOnce(memberResponse()).mockRejectedValueOnce(new Error('offline'));
    expect((await list()).cohosts[0]).toMatchObject({ did: COHOST, name: null, handle: null, avatar: null });
  });

  it('keeps null profile fields on non-2xx lookup responses', async () => {
    mocks.fetch.mockResolvedValueOnce(memberResponse()).mockResolvedValueOnce(jsonResponse({}, 503));
    expect((await list()).cohosts[0]).toMatchObject({ did: COHOST, name: null, handle: null, avatar: null });
  });
});

describe('creator-only membership changes', () => {
  it.each([add, remove])('denies both cohosts and strangers', async (action) => {
    for (const did of [COHOST, OTHER]) {
      await expect(action({ did: OTHER }, did)).rejects.toMatchObject({ status: 403 });
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('adds through the public connections API and forwards the caller cookie', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} })).mockResolvedValueOnce(memberResponse([]));
    const result = await add();
    expect(result.cohost).toMatchObject({ did: COHOST, role: 'cohost', addedAt: MEMBER.joinedAt });
    expect(mocks.fetch).toHaveBeenCalledWith(`${membershipUrl}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ did: COHOST, role: 'cohost' }),
    });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('resolves @handle and retains repeat-add idempotence', async () => {
    const result = await add({ handle: '@cohost' });
    expect(result.cohost.did).toBe(COHOST);
    expect(mocks.fetch).toHaveBeenCalledWith('https://profile.test/api/profile/by-handle/cohost', { cache: 'no-store' });
    expect(mocks.fetch.mock.calls.some(([url]) => url === `${membershipUrl}/members`)).toBe(false);
  });

  it('uses the input handle when the profile omits it', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ did: COHOST, avatarUrl: '/avatar.png' }));
    expect((await add({ handle: '@cohost' })).cohost).toMatchObject({
      name: null, handle: 'cohost', avatar: '/avatar.png',
    });
  });

  it('skips chat enrollment when the event has no DID', async () => {
    mocks.event.mockResolvedValue({ ...EVENT, did: null });
    await add();
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/api/d/'))).toBe(false);
  });

  it('skips chat enrollment when the chat service is not configured', async () => {
    mocks.serviceUrl.mockImplementation((service: string) => service === 'chat' ? undefined : `https://${service}.test`);
    await add();
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/api/d/'))).toBe(false);
  });

  it('uses the documented DELETE members JSON-body contract, not a DID path', async () => {
    expect(await remove()).toEqual({ removed: true });
    expect(mocks.fetch).toHaveBeenCalledWith(`${membershipUrl}/members`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ did: COHOST }),
    });
  });

  it.each([{}, { did: '' }, { did: 7 }, { did: 'not-a-did' }, null, []])('rejects invalid removal target %j', async (body) => {
    await expect(remove(body)).rejects.toMatchObject({ status: 400 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { did: 7 }, { did: 'not-a-did' }, { handle: 9 }, { handle: '@' }, null, []])(
    'rejects invalid addition target %j', async (body) => {
      await expect(add(body)).rejects.toMatchObject({ status: 400 });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([add, remove])('rejects self/creator target', async (action) => {
    await expect(action({ did: OWNER })).rejects.toMatchObject({ status: 400 });
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/api/pods'))).toBe(false);
  });

  it.each([
    { members: [] },
    { members: [{ ...MEMBER, removedAt: '2026-10-14T13:00:00Z' }] },
    { members: [{ ...MEMBER, role: 'member' }] },
  ])('rejects unknown, removed, and noncohost members', async ({ members }) => {
    mocks.fetch.mockResolvedValueOnce(memberResponse(members));
    await expect(remove()).rejects.toMatchObject({ status: 404, message: 'Cohost not found' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects missing pod for removal without creating one', async () => {
    mocks.event.mockResolvedValue({ ...EVENT, podId: null });
    await expect(remove()).rejects.toMatchObject({ status: 500, message: 'Event pod not initialized' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([add, remove])('rejects invalid blank pod identifiers', async (action) => {
    mocks.event.mockResolvedValue({ ...EVENT, podId: ' ' });
    await expect(action()).rejects.toMatchObject({ status: 500 });
  });

  it.each(['http', 'network'])('keeps successful add when chat sync fails: %s', async (failure) => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} })).mockResolvedValueOnce(memberResponse());
    if (failure === 'http') mocks.fetch.mockResolvedValueOnce(jsonResponse({ error: 'offline' }, 503));
    else mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    expect((await add()).cohost.did).toBe(COHOST);
    expect(mocks.log.warn).toHaveBeenCalled();
  });
});

describe('lazy event pod initialization', () => {
  beforeEach(() => mocks.event.mockResolvedValue({ ...EVENT, podId: null }));

  it('creates a private event pod and attaches it once', async () => {
    await add();
    expect(mocks.fetch).toHaveBeenCalledWith('https://connections.test/api/pods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ name: EVENT.title, type: 'event', visibility: 'private' }),
    });
    expect(mocks.attach).toHaveBeenCalledWith(EVENT_ID, POD_ID);
  });

  it('uses the winning pod when another initializer attaches first', async () => {
    mocks.attach.mockResolvedValue({ ...EVENT, podId: 'pod_winner' });
    await add();
    expect(mocks.fetch).toHaveBeenCalledWith('https://connections.test/api/pods/pod_winner', {
      headers: { cookie: COOKIE }, cache: 'no-store',
    });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      { eventId: EVENT_ID, unusedPodId: POD_ID }, expect.any(String),
    );
  });

  it('preserves the public verified-identity/trust-graph gate error', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} })).mockResolvedValueOnce(
      jsonResponse({ error: 'This action requires at least one connection in the trust graph' }, 403),
    );
    await expect(add()).rejects.toMatchObject({ status: 403, message: 'This action requires at least one connection in the trust graph' });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('rejects malformed creation response', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} })).mockResolvedValueOnce(jsonResponse({ pod: {} }));
    await expect(add()).rejects.toMatchObject({ status: 502, message: 'Invalid connections pod response' });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('handles the event disappearing during attachment', async () => {
    mocks.attach.mockResolvedValue(null);
    await expect(add()).rejects.toMatchObject({ status: 404 });
  });

  it('does not initialize a pod for an invalid target', async () => {
    await expect(add({ did: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('upstream failures', () => {
  it.each([401, 403, 404, 429, 503])('preserves membership read status %s and meaningful message', async (status) => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ error: 'Meaningful upstream failure' }, status));
    await expect(remove()).rejects.toMatchObject({ status, message: 'Meaningful upstream failure' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('never writes when the membership read is unreachable', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(remove()).rejects.toMatchObject({ status: 502, message: 'Failed to reach connections service' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates add errors instead of swallowing them', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} }))
      .mockResolvedValueOnce(memberResponse([]))
      .mockResolvedValueOnce(jsonResponse({ error: 'Invalid target identity' }, 400));
    await expect(add()).rejects.toMatchObject({ status: 400, message: 'Invalid target identity' });
  });

  it('handles non-JSON upstream errors', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(remove()).rejects.toMatchObject({ status: 503, message: 'Connections request failed' });
  });

  it.each([null, {}, { members: null }])('rejects malformed membership response %j', async (body) => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(body));
    await expect(remove()).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a removal response without success confirmation', async () => {
    mocks.fetch.mockResolvedValueOnce(memberResponse()).mockResolvedValueOnce(jsonResponse({ removed: false }));
    await expect(remove()).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a malformed add response', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ identity: {} })).mockResolvedValueOnce(memberResponse([]))
      .mockResolvedValueOnce(jsonResponse({}));
    await expect(add()).rejects.toMatchObject({ status: 502 });
  });

  it('reports an unconfigured connections service without issuing HTTP', async () => {
    mocks.serviceUrl.mockReturnValue(undefined);
    await expect(remove()).rejects.toMatchObject({ status: 502, message: 'Connections service is not configured' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reports unknown handles', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ error: 'Handle not found' }, 404));
    await expect(add({ handle: '@unknown' })).rejects.toMatchObject({ status: 404 });
  });

  it('reports unresolved handles without sending a membership mutation', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ did: 'invalid' }));
    await expect(add({ handle: '@unknown' })).rejects.toMatchObject({ status: 404 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports unreachable handle resolver', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(add({ handle: '@unknown' })).rejects.toMatchObject({ status: 502 });
  });
});
