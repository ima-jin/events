import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backfillContactEmail, evaluateEligibility, getContactEmail, isPodMember,
  listMemberPodIds, lookupOrderPayments, resolveProfiles, sendOrderOnboard,
} from '@/lib/kernel';
import { getPayAppToken, invalidatePayAppToken } from '@/lib/pay-app-token';

vi.mock('@/lib/pay-app-token', () => ({
  getPayAppToken: vi.fn(), invalidatePayAppToken: vi.fn(),
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ warn }) }));

const fetchMock = vi.fn();
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
const profile = { did: 'did:buyer', handle: 'buyer', displayName: 'Buyer' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
  vi.stubEnv('IMAJIN_AUTH_URL', '');
  for (const service of ['AUTH', 'PAY', 'PROFILE', 'CONNECTIONS']) vi.stubEnv(`${service}_SERVICE_URL`, '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.mocked(getPayAppToken).mockReset().mockResolvedValue('test-service-jwt');
  vi.mocked(invalidatePayAppToken).mockReset().mockResolvedValue();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('scoped profile and contact calls', () => {
  it('attaches the existing service JWT without cookie or app-header authority', async () => {
    fetchMock.mockResolvedValue(reply({ results: [{ ...profile, email: 'buyer@example.test' }] }));
    expect(await getContactEmail(profile.did)).toBe('buyer@example.test');
    expect(fetchMock).toHaveBeenCalledWith('https://kernel.test/profile/api/resolve', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer test-service-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dids: [profile.did] }), cache: 'no-store', redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
  });
  it('deduplicates profiles and splits batches at 200', async () => {
    fetchMock.mockResolvedValue(reply({ results: [profile] }));
    const dids = Array.from({ length: 201 }, (_, n) => `did:${n}`);
    expect((await resolveProfiles([...dids, dids[0], ''])).size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).dids).toHaveLength(200);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).dids).toHaveLength(1);
  });
  it('honors omitted email and empty results', async () => {
    fetchMock.mockResolvedValueOnce(reply({ results: [profile] })).mockResolvedValueOnce(reply({}));
    expect(await getContactEmail(profile.did)).toBeNull();
    expect(await resolveProfiles(['did:other'])).toEqual(new Map());
  });
  it.each([null, { results: {} }, { results: [null, {}] }])('ignores malformed profile results: %j', async (body) => {
    fetchMock.mockResolvedValue(reply(body));
    expect(await getContactEmail(profile.did)).toBeNull();
  });
  it('refreshes exactly once on 401 and uses the refreshed token', async () => {
    vi.mocked(getPayAppToken).mockResolvedValueOnce('old').mockResolvedValueOnce('fresh');
    fetchMock.mockResolvedValueOnce(reply({}, 401)).mockResolvedValueOnce(reply({ results: [profile] }));
    expect((await resolveProfiles([profile.did])).get(profile.did)).toEqual(profile);
    expect(invalidatePayAppToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });
  it('does not loop when refresh is refused', async () => {
    fetchMock.mockResolvedValue(reply({}, 401));
    expect(await backfillContactEmail(profile.did, 'buyer@example.test')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidatePayAppToken).toHaveBeenCalledTimes(1);
  });
  it('accepts a successful idempotent backfill no-op', async () => {
    fetchMock.mockResolvedValue(reply({ did: profile.did, contactEmail: null, backfilled: false }));
    expect(await backfillContactEmail(profile.did, 'buyer@example.test')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://kernel.test/auth/api/identity/did%3Abuyer/contact');
  });
});

describe('app pod membership', () => {
  it('permits active owner/cohost without a cookie, never forwards a supplied cookie', async () => {
    fetchMock.mockResolvedValue(reply({ members: [{ did: profile.did, role: 'cohost' }] }));
    expect(await isPodMember('pod/one', profile.did, undefined, 'private-cookie')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://kernel.test/connections/api/apps/pods/pod%2Fone/members');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer test-service-jwt' });
  });
  it.each([
    { members: [{ did: profile.did, role: 'member' }] },
    { members: [{ did: profile.did, role: 'owner', removedAt: '2026-01-01' }] },
    { members: [{ did: 'did:other', role: 'owner' }] },
    { members: [] }, { members: null }, {},
  ])('denies wrong role, removed, other and malformed members: %j', async (body) => {
    fetchMock.mockResolvedValue(reply(body));
    expect(await isPodMember('pod', profile.did)).toBe(false);
  });
  it('queries the explicit target DID and filters non-string pod IDs', async () => {
    fetchMock.mockResolvedValue(reply({ podIds: ['pod1', null, 12] }));
    expect(await listMemberPodIds('did:subject?x')).toEqual(['pod1']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://kernel.test/connections/api/apps/pods?did=did%3Asubject%3Fx');
  });
  it('invalidates 401 without retrying a membership read', async () => {
    fetchMock.mockResolvedValue(reply({}, 401));
    expect(await listMemberPodIds(profile.did)).toEqual([]);
    expect(invalidatePayAppToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('kernel-private onboarding', () => {
  it('posts only the stored kernel transaction reference and returns status only', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'sent' }));
    expect(await sendOrderOnboard('tx_1')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://kernel.test/auth/api/onboard/send');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ transactionId: 'tx_1' });
  });
  it('refreshes once on 401 but does not accept other status bodies', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 401)).mockResolvedValueOnce(reply({ status: 'queued' }));
    expect(await sendOrderOnboard('tx_1')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('skips an absent reference', async () => {
    expect(await sendOrderOnboard('')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payment enrichment', () => {
  it('deduplicates stored sessions in batches of at most 100 and retains only safe metadata', async () => {
    const sessions = Array.from({ length: 101 }, (_, n) => `cs_${n}`);
    fetchMock.mockResolvedValueOnce(reply({ transactions: [
      { transactionId: 'tx_1', sessionId: 'cs_1', metadata: { orderId: 'o1', email: 'private', service: 'events', type: 'x'.repeat(201), eventId: 4 } },
      { transactionId: 'tx_foreign', sessionId: 'cs_not_requested', metadata: {} },
      null, {}, { transactionId: '', sessionId: 'cs_2' },
    ] })).mockResolvedValueOnce(reply({ transactions: [] }));
    expect(await lookupOrderPayments('did:seller', [...sessions, sessions[0], null, ''])).toEqual([
      { transactionId: 'tx_1', sessionId: 'cs_1', metadata: { orderId: 'o1', service: 'events' } },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sellerDid: 'did:seller', sessionIds: sessions.slice(0, 100) });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).sessionIds).toEqual(['cs_100']);
  });
  it('retains multiple matching rows so consumers can reject ambiguity', async () => {
    fetchMock.mockResolvedValue(reply({ transactions: [
      { transactionId: 'tx_1', sessionId: 'cs_1' }, { transactionId: 'tx_2', sessionId: 'cs_1', metadata: null },
    ] }));
    expect(await lookupOrderPayments('did:seller', ['cs_1'])).toHaveLength(2);
  });
  it('returns no partial data if a later batch is refused', async () => {
    fetchMock.mockResolvedValueOnce(reply({ transactions: [{ transactionId: 'tx_1', sessionId: 'cs_0' }] }))
      .mockResolvedValueOnce(reply({}, 403));
    expect(await lookupOrderPayments('did:seller', Array.from({ length: 101 }, (_, n) => `cs_${n}`))).toEqual([]);
  });
  it('skips missing seller and empty session lists', async () => {
    expect(await lookupOrderPayments('', ['cs_1'])).toEqual([]);
    expect(await lookupOrderPayments('did:seller', [null, ''])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('invalidates 401 without retrying payment reads', async () => {
    fetchMock.mockResolvedValue(reply({}, 401));
    expect(await lookupOrderPayments('did:seller', ['cs_1'])).toEqual([]);
    expect(invalidatePayAppToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fail-closed behavior', () => {
  it.each([403, 404, 429, 500, 503])('never retries refusal %s or exposes response bodies', async (status) => {
    fetchMock.mockImplementation(async () => reply({ error: 'sensitive-body' }, status));
    expect(await getContactEmail(profile.did)).toBeNull();
    expect(await backfillContactEmail(profile.did, 'buyer@example.test')).toBe(false);
    expect(await isPodMember('pod', profile.did)).toBe(false);
    expect(await listMemberPodIds(profile.did)).toEqual([]);
    expect(await sendOrderOnboard('tx_1')).toBe(false);
    expect(await lookupOrderPayments('did:seller', ['cs_1'])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(invalidatePayAppToken).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-body');
  });
  it.each(['network', 'mint', 'json', 'invalidation'])('handles %s failure without leaking errors', async (failure) => {
    fetchMock.mockResolvedValue(reply({}, 401));
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('private-error'));
    if (failure === 'mint') vi.mocked(getPayAppToken).mockRejectedValue(new Error('private-error'));
    if (failure === 'json') fetchMock.mockResolvedValue(new Response('private-invalid-json'));
    if (failure === 'invalidation') vi.mocked(invalidatePayAppToken).mockRejectedValue(new Error('private-error'));
    expect(await sendOrderOnboard('tx_1')).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
  it('skips calls when the service is unconfigured', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    expect(await sendOrderOnboard('tx_1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not attach the JWT globally to unrelated kernel calls', async () => {
    fetchMock.mockResolvedValue(reply({ upgraded: true }));
    expect(await evaluateEligibility(profile.did)).toEqual({ upgraded: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(getPayAppToken).not.toHaveBeenCalled();
  });
});
