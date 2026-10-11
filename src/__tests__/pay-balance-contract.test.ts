/**
 * Contract test (#2137, sibling of #2002/PR #2133): the events app's
 * `GET /api/balance` proxy and the pay service's published API (the
 * checked-in fixture `test/fixtures/pay-contract.ts`) must agree on the same
 * path, auth scheme and response fields — and a failed upstream call must
 * never come back disguised as a real zero balance.
 *
 * The route handler is exercised for real (the pay service is a stubbed
 * `fetch`), and its outbound request is checked against the fixture, so a
 * drift between call site and contract fails CI instead of surfacing as a
 * runtime 404.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  authFailure,
  authSuccess,
  mockLog,
  requireAuthMock,
  resetRouteTestMocks,
} from './support/route-test-support';
import {
  PAY_BASE_URL,
  createFetchMock,
  expectCallUrl,
  expectCookieAuth,
  payOperation,
} from './support/pay-contract-support';
import { PAY_CONTRACT } from '../../test/fixtures/pay-contract';

const BALANCE_PATH = '/api/balance/{did}';
const BUYER_DID = 'did:imajin:buyer';
const SESSION_COOKIE = 'session=abc';

const fetchMock = createFetchMock();
let GET: (request: NextRequest) => Promise<Response>;

function makeRequest(): NextRequest {
  return new NextRequest('https://events.test/api/balance', {
    headers: { cookie: SESSION_COOKIE },
  });
}

function jsonOk(data: unknown) {
  return { ok: true, json: async () => data };
}

beforeAll(async () => {
  // The route reads PAY_SERVICE_URL once at module load, so stub it first.
  vi.stubEnv('PAY_SERVICE_URL', PAY_BASE_URL);
  ({ GET } = await import('../../app/api/balance/route'));
});

beforeEach(() => {
  resetRouteTestMocks();
  requireAuthMock.mockResolvedValue(authSuccess(BUYER_DID));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pay balance contract (call site vs published pay API)', () => {
  it('documents GET /api/balance/{did} with cookie or bearer auth', () => {
    const operation = payOperation(BALANCE_PATH, 'get');

    expect(operation.operationId).toBe('getBalance');
    expect(operation.security).toEqual(expect.arrayContaining(['cookieAuth', 'bearerAuth']));
    expect(operation.parameters).toEqual([{ name: 'did', in: 'path', required: true }]);
  });

  it("requests the documented path with the caller's DID and forwarded session cookie, not a duplicated /pay prefix", async () => {
    fetchMock.mockResolvedValue(jsonOk({ total: 0, currency: 'CAD' }));

    await GET(makeRequest());

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expectCallUrl(call, BALANCE_PATH, { did: BUYER_DID });
    expect(call[0]).toContain('/api/balance/did%3Aimajin%3Abuyer');
    expectCookieAuth(call, payOperation(BALANCE_PATH, 'get'), SESSION_COOKIE);
  });

  it('reads the Balance fields (total, currency) the contract documents', async () => {
    expect(Object.keys(PAY_CONTRACT.schemas.Balance.properties)).toEqual(
      expect.arrayContaining(['total', 'currency']),
    );
    fetchMock.mockResolvedValue(
      jsonOk({
        did: BUYER_DID,
        balances: [{ unit: 'MJN', amount: 40, withdrawable: true }, { unit: 'MJNx', amount: 2.5, withdrawable: false }],
        total: 42.5,
        currency: 'USD',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 42.5, currency: 'USD' });
  });
});

describe('GET /api/balance (#2137: upstream failures must not hide as a real zero)', () => {
  it('returns 401 when auth fails and never calls the pay service', async () => {
    requireAuthMock.mockResolvedValue(authFailure());

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the pay service as an unavailable balance (502), logging the status + url', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const res = await GET(makeRequest());

    // A 404 must be visibly distinguishable from a real zero balance.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ balance: 0, currency: 'CAD', unavailable: true });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, url: expect.stringContaining('/api/balance/') }),
      expect.any(String),
    );
  });

  it('surfaces a fetch/network failure the same way (unavailable, non-200, logged)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ balance: 0, unavailable: true });
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('passes through a real balance on a 200 upstream response, without the unavailable flag', async () => {
    fetchMock.mockResolvedValue(jsonOk({ total: 42.5, currency: 'USD' }));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ balance: 42.5, currency: 'USD' });
    expect(body.unavailable).toBeUndefined();
  });

  it('defaults a missing total/currency in a 200 response to a 0 CAD balance', async () => {
    fetchMock.mockResolvedValue(jsonOk({}));

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 0, currency: 'CAD' });
  });
});
