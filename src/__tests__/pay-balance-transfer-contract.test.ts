/**
 * Contract test (#2002): the events app's balance transfer call
 * (`transferBuyerBalance`) and the pay service's published API (the
 * checked-in fixture `test/fixtures/pay-contract.ts`) must agree on the same
 * path, method, auth scheme and request body.
 *
 * The helper is exercised for real against a stubbed `fetch`; its outbound
 * request is checked against the fixture, so a future drift fails CI
 * immediately instead of surfacing as a runtime 404/400.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@ima-jin/logger';
import { transferBuyerBalance } from '../lib/balance-checkout-helpers';
import {
  PAY_BASE_URL,
  createFetchMock,
  expectBodyMatchesContract,
  expectCallUrl,
  expectCookieAuth,
  payOperation,
} from './support/pay-contract-support';

const TRANSFER_PATH = '/api/balance/transfer';
const SESSION_COOKIE = 'session=abc';

const fetchMock = createFetchMock();
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

const TRANSFER_PARAMS = {
  payServiceUrl: PAY_BASE_URL,
  cookieHeader: SESSION_COOKIE,
  fromDid: 'did:imajin:buyer',
  toDid: 'did:imajin:creator',
  amountCents: 2550,
  eventId: 'evt_1',
  cart: [],
  log: log as unknown as Logger,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pay.yaml balance/transfer contract', () => {
  it('documents POST /api/balance/transfer with cookie or bearer auth', () => {
    const operation = payOperation(TRANSFER_PATH, 'post');

    expect(operation.operationId).toBe('transferBalance');
    expect(operation.security).toEqual(expect.arrayContaining(['cookieAuth', 'bearerAuth']));
    expect(operation.requestBody?.required).toEqual(['from_did', 'to_did', 'amount']);
  });

  it('POSTs the documented path (no duplicated /pay prefix) with the forwarded session cookie', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ transactionId: 'tx_1' }) });

    await transferBuyerBalance(TRANSFER_PARAMS);

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expectCallUrl(call, TRANSFER_PATH);
    expect(call[1]?.method).toBe('POST');
    expectCookieAuth(call, payOperation(TRANSFER_PATH, 'post'), SESSION_COOKIE);
  });

  it('sends a body with every required field, only documented fields, and the amount in dollars', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ transactionId: 'tx_1' }) });

    await transferBuyerBalance(TRANSFER_PARAMS);

    const body = expectBodyMatchesContract(fetchMock.mock.calls[0], payOperation(TRANSFER_PATH, 'post'));
    expect(body).toMatchObject({
      from_did: 'did:imajin:buyer',
      to_did: 'did:imajin:creator',
      amount: 25.5, // transfer expects dollars, not cents
      metadata: { service: 'events', eventId: 'evt_1' },
    });
  });

  it('returns the transaction id from a successful transfer', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ transactionId: 'tx_9' }) });

    await expect(transferBuyerBalance(TRANSFER_PARAMS)).resolves.toEqual({ transactionId: 'tx_9' });
  });

  it.each([
    [402, 402, 'Insufficient balance'],
    [403, 403, 'Forbidden'],
    [500, 502, 'boom'],
  ])('maps a documented/undocumented %i upstream failure to status %i', async (upstream, expected, error) => {
    fetchMock.mockResolvedValue({ ok: false, status: upstream, json: async () => ({ error }) });

    await expect(transferBuyerBalance(TRANSFER_PARAMS)).resolves.toEqual({ error, status: expected });
    expect(log.warn).toHaveBeenCalled();
  });
});
