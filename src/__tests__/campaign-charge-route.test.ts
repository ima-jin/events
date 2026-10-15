import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKER_DID, CREATOR_DID, EVENT_ID, campaignJsonRequest, campaignRequest,
  makeEvent, makePledge, resetCampaignMocks,
} from './support/campaign-route-support';
import {
  nextSelect, nextUpdate, setMock, setValues, updateMock, whereMock, whereParams,
} from './support/db-queue-support';
import { fetchMock, jsonResponse, textResponse } from './support/kernel-mock-support';
import { resetPayAppTokenMocks } from './support/pay-app-token-support';
import { mockLog } from './support/route-test-support';
import { POST } from '../../app/api/campaign/[eventId]/settle/route';

const recorded = () => [1, 2, 3].map((n) => makePledge({
  id: `plg_${n}`,
  stripeSetupIntentId: `seti_${n}`,
  stripeCustomerId: `cus_${n}`,
  stripePaymentMethodId: `pm_${n}`,
  metadata: { sellerDid: `did:imajin:seller${n}` },
}));
const charged = (pledgeId: string) => ({ pledgeId, status: 'charged' });
const allCharged = () => recorded().map((p) => charged(String(p.id)));
const settle = () => POST(campaignRequest(EVENT_ID, 'settle'));

function queueBatch(rows = recorded()): void {
  nextSelect([makeEvent({ targetAmount: 1000 })]);
  nextSelect(rows);
}

describe('seller-bound campaign charges', () => {
  beforeEach(() => {
    whereMock.mockReset();
    resetCampaignMocks();
    resetPayAppTokenMocks();
  });

  it('sends recorded seller/setup bindings per pledge and ignores client input', async () => {
    const rows = recorded();
    rows[2].metadata = {};
    queueBatch(rows);
    fetchMock.mockResolvedValue(jsonResponse(200, { results: allCharged() }));
    const response = await POST(campaignJsonRequest(`${EVENT_ID}/settle`, {
      eventId: 'evt_attacker', sellerDid: 'did:imajin:attacker', setupIntentId: 'seti_attacker',
      pledges: [{ pledgeId: 'plg_attacker', sellerDid: 'did:imajin:attacker' }],
    }));
    expect(response.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      eventId: EVENT_ID,
      pledges: [
        { pledgeId: 'plg_1', setupIntentId: 'seti_1', sellerDid: 'did:imajin:seller1' },
        { pledgeId: 'plg_2', setupIntentId: 'seti_2', sellerDid: 'did:imajin:seller2' },
        { pledgeId: 'plg_3', setupIntentId: 'seti_3', sellerDid: CREATOR_DID },
      ],
    });
  });

  it('records mixed three-pledge outcomes independently, strips prose and derives counts', async () => {
    queueBatch();
    const results = [
      charged('plg_1'),
      { pledgeId: 'plg_2', status: 'failed', code: 'PLEDGE_BINDING_MISMATCH' },
      charged('plg_3'),
    ];
    fetchMock.mockResolvedValue(jsonResponse(200, {
      charged: 99, failed: 0, total: -1,
      results: results.map((result) => ({ ...result, error: 'sensitive upstream prose' })),
    }));
    const response = await settle();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ charged: 2, failed: 1, total: 3, results });
    expect(setValues()).toEqual([
      { status: 'charged', chargedAt: expect.any(Date) },
      { status: 'failed', failureReason: 'PLEDGE_BINDING_MISMATCH' },
      { status: 'charged', chargedAt: expect.any(Date) },
    ]);
    for (const n of [1, 2, 3]) {
      expect(whereParams(n + 1)).toEqual([
        `plg_${n}`, EVENT_ID, 'confirmed', BACKER_DID, 5000, 'CAD',
        `seti_${n}`, `cus_${n}`, `pm_${n}`, JSON.stringify({ sellerDid: `did:imajin:seller${n}` }),
      ]);
    }
    const condition = whereMock.mock.calls[2][0];
    const query = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
    for (const column of [
      'id', 'event_id', 'status', 'backer_did', 'amount', 'currency',
      'stripe_setup_intent_id', 'stripe_customer_id', 'stripe_payment_method_id', 'metadata',
    ]) {
      expect(query.sql).toContain(`"${column}"`);
    }
    expect(query.sql).toContain('is not distinct from');
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('matches out-of-order results to requested IDs rather than array position', async () => {
    queueBatch();
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [
      charged('plg_3'),
      charged('plg_1'),
      { pledgeId: 'plg_2', status: 'failed', code: 'PLEDGE_SETUP_NOT_FOUND' },
    ] }));
    expect((await settle()).status).toBe(200);
    expect(setValues().map((value) => value.status)).toEqual(['charged', 'failed', 'charged']);
    expect(whereParams(2)[0]).toBe('plg_1');
    expect(whereParams(3)[0]).toBe('plg_2');
    expect(whereParams(4)[0]).toBe('plg_3');
  });

  it.each([
    { metadata: { sellerDid: '' } },
    { metadata: { sellerDid: 42 } },
    { metadata: { sellerDid: 'untrusted-seller' } },
    { stripeSetupIntentId: null },
    { stripeSetupIntentId: 'invalid-setup' },
  ])('does not charge or mutate a corrupt recorded binding %j', async (overrides) => {
    queueBatch([makePledge(overrides)]);
    expect((await settle()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown id', [charged('plg_1'), charged('plg_2'), charged('plg_elsewhere')]],
    ['duplicate id', [charged('plg_1'), charged('plg_2'), charged('plg_1')]],
    ['missing id', [charged('plg_1'), charged('plg_2')]],
    ['empty results', []],
    ['invalid status', [charged('plg_1'), charged('plg_2'), { pledgeId: 'plg_3', status: 'pending' }]],
    ['missing code', [charged('plg_1'), charged('plg_2'), { pledgeId: 'plg_3', status: 'failed' }]],
    ['empty code', [charged('plg_1'), charged('plg_2'), { pledgeId: 'plg_3', status: 'failed', code: '' }]],
    ['prose code', [charged('plg_1'), charged('plg_2'), { pledgeId: 'plg_3', status: 'failed', code: 'secret error prose' }]],
    ['null outcome', [charged('plg_1'), charged('plg_2'), null]],
  ])('rejects %s with no mutations, including earlier valid results', async (_name, results) => {
    queueBatch();
    fetchMock.mockResolvedValue(jsonResponse(200, { results }));
    const response = await settle();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Failed to charge pledges' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { results: {} }])('rejects malformed successful envelopes %j', async (body) => {
    queueBatch();
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    expect((await settle()).status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('fails closed on invalid JSON, without retry or upstream logging', async () => {
    queueBatch();
    fetchMock.mockResolvedValue(textResponse(200, 'secret error prose', 'OK'));
    expect((await settle()).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('preserves typed 403 without returning or logging upstream prose', async () => {
    queueBatch();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'secret error prose' }));
    const response = await settle();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('approve pay:charge-pledges');
    expect(body.error).not.toContain('secret error prose');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('replay selects no terminal rows and does not fetch or write again', async () => {
    queueBatch();
    fetchMock.mockResolvedValue(jsonResponse(200, { results: allCharged() }));
    expect((await settle()).status).toBe(200);
    fetchMock.mockClear();
    updateMock.mockClear();
    nextSelect([makeEvent()]);
    nextSelect([]);
    const response = await settle();
    expect(await response.json()).toEqual({ charged: 0, failed: 0, total: 0, results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['charged', 'failed'])('a stale concurrent result cannot rewrite a %s row', async (status) => {
    const row = makePledge();
    const persisted: Record<string, unknown> = { status: 'confirmed' };
    whereMock.mockImplementation((condition) => {
      const query = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
      if (query.params[0] === row.id && persisted.status === query.params[2]) {
        Object.assign(persisted, setMock.mock.calls.at(-1)?.[0]);
      }
    });
    queueBatch([row]);
    queueBatch([row]);
    let release!: (value: Response) => void;
    let started!: () => void;
    const arrived = new Promise<void>((resolve) => { started = resolve; });
    const failed = { pledgeId: 'plg_1', status: 'failed', code: 'PLEDGE_CHARGE_ALREADY_ATTEMPTED' };
    const first = status === 'charged' ? charged('plg_1') : failed;
    const later = status === 'charged' ? failed : charged('plg_1');
    fetchMock.mockImplementationOnce(() => {
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    }).mockResolvedValueOnce(jsonResponse(200, { results: [first] }));
    const stale = settle();
    // The first call must reach pay before the second consumes its select queue.
    await arrived;
    expect((await settle()).status).toBe(200);
    const terminal = { ...persisted };
    expect(persisted.status).toBe(status);
    release(jsonResponse(200, { results: [later] }));
    expect((await stale).status).toBe(200);
    expect(persisted).toEqual(terminal);
    expect(whereParams(4)).toContain('confirmed');
    expect(whereParams(5)).toContain('confirmed');
    whereMock.mockReset();
  });

  it('uses null-safe guards for legacy nullable payment fields and metadata', async () => {
    queueBatch([makePledge({ metadata: null, stripeCustomerId: null, stripePaymentMethodId: null })]);
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [charged('plg_1')] }));
    nextUpdate([]);
    expect((await settle()).status).toBe(200);
    expect(whereParams(2)).toEqual([
      'plg_1', EVENT_ID, 'confirmed', BACKER_DID, 5000, 'CAD', 'seti_1', null, null, null,
    ]);
  });
});
