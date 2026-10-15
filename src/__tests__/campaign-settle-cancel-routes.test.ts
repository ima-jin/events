/**
 * POST /api/campaign/{eventId}/settle and /cancel — the creator-only money
 * actions of a crowdfunding campaign. Shared mocks / blocks live in
 * support/campaign-route-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_ID,
  BACKER_DID,
  CREATOR_DID,
  campaignRequest,
  expectCors,
  itAnswers500WhenHandlerThrows,
  itAnswersPreflight,
  itRateLimits,
  itRejectsMissingEventId,
  itRejectsNonCampaignEvent,
  itRejectsNonCreator,
  itRejectsUnauthenticated,
  itRejectsUnknownEvent,
  makeEvent,
  makePledge,
  resetCampaignMocks,
} from './support/campaign-route-support';
import { nextSelect, nextUpdate, setValues, updatedTables, updateMock, whereParams } from './support/db-queue-support';
import { fetchMock, jsonResponse, payUrl, textResponse } from './support/kernel-mock-support';
import { APP_TOKEN, getPayAppTokenMock, invalidatePayAppTokenMock, resetPayAppTokenMocks } from './support/pay-app-token-support';
import { mockLog } from './support/route-test-support';
import { events, pledges } from '@/db';
import { OPTIONS as cancelOptions, POST as postCancel } from '../../app/api/campaign/[eventId]/cancel/route';
import { OPTIONS as settleOptions, POST as postSettle } from '../../app/api/campaign/[eventId]/settle/route';

const settle = (eventId = EVENT_ID) => postSettle(campaignRequest(eventId, 'settle'));
const cancel = (eventId = EVENT_ID) => postCancel(campaignRequest(eventId, 'cancel'));
const ERR_SETTLE_FAILED = 'Failed to settle campaign';
const ERR_CHARGE_FAILED = 'Failed to charge pledges';

/** Two confirmed pledges worth 6000 in total (target 10 000 by default). */
const confirmedPledges = (amounts = [4000, 2000]) =>
  amounts.map((amount, index) => makePledge({
    id: `plg_${index + 1}`, amount, stripeCustomerId: `cus_${index + 1}`, stripeSetupIntentId: `seti_${index + 1}`,
  }));

/** Queue the event + confirmed pledges a settle needs to reach the pay service. */
function queueSettleable(targetAmount: number | null = 5000): void {
  nextSelect([makeEvent({ targetAmount })]);
  nextSelect(confirmedPledges());
}

const chargedResults = () => ({
  results: [
    { pledgeId: 'plg_1', status: 'charged' },
    { pledgeId: 'plg_2', status: 'charged' },
  ],
});

describe('POST /api/campaign/{eventId}/settle', () => {
  beforeEach(() => {
    resetCampaignMocks();
    resetPayAppTokenMocks();
  });

  it('re-mints once on 401 and preserves the bound setup ids', async () => {
    queueSettleable();
    getPayAppTokenMock.mockResolvedValueOnce('expired').mockResolvedValueOnce('fresh');
    fetchMock.mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200, chargedResults()));
    expect((await settle()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidatePayAppTokenMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  });

  it.each([401, 403])('leaves pledges untouched on persistent authorization failure %s', async (status) => {
    queueSettleable();
    fetchMock.mockImplementation(async () => jsonResponse(status, { error: 'scope or ownership refused' }));
    const res = await settle();
    expect(res.status).toBe(status === 403 ? 403 : 503);
    if (status === 403) {
      expect(await res.json()).toEqual({ error: expect.stringContaining('approve pay:charge-pledges') });
      expect(invalidatePayAppTokenMock).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not charge or mutate pledges when the app token is unavailable', async () => {
    queueSettleable();
    getPayAppTokenMock.mockRejectedValue(new Error('not provisioned'));
    expect((await settle()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  itAnswersPreflight(settleOptions);
  itRateLimits(() => settle(), 5);
  itRejectsUnauthenticated(() => settle());
  itRejectsMissingEventId(() => settle(''));
  itRejectsUnknownEvent(() => settle());
  itRejectsNonCampaignEvent(() => settle());
  itRejectsNonCreator(() => settle(), 'Only the campaign creator can settle');
  itAnswers500WhenHandlerThrows(() => settle(), () => nextSelect(new Error('boom')), {
    error: ERR_SETTLE_FAILED,
    logMessage: 'Campaign settle error',
  });

  it('returns an empty result without calling the pay service when nothing is confirmed', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);

    const res = await settle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ charged: 0, failed: 0, total: 0, results: [] });
    expectCors(res);
    expect(whereParams(1)).toEqual([EVENT_ID, 'confirmed']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 400 while the confirmed pledges are below the target', async () => {
    queueSettleable(10_000);

    const res = await settle();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Campaign target has not been met' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('charges the pledges through the pay service and records each outcome', async () => {
    const chargeResult = {
      charged: 1,
      failed: 1,
      total: 2,
      results: [
        { pledgeId: 'plg_1', status: 'charged' },
        { pledgeId: 'plg_2', status: 'failed', code: 'PLEDGE_BINDING_MISMATCH' },
      ],
    };
    queueSettleable(6000);
    fetchMock.mockResolvedValue(jsonResponse(200, chargeResult));

    const res = await settle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(chargeResult);
    expectCors(res);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${payUrl}/api/charge-pledges`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${APP_TOKEN}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      eventId: EVENT_ID,
      pledges: [
        { pledgeId: 'plg_1', setupIntentId: 'seti_1', sellerDid: CREATOR_DID },
        { pledgeId: 'plg_2', setupIntentId: 'seti_2', sellerDid: CREATOR_DID },
      ],
    });

    expect(updatedTables()).toEqual([pledges, pledges]);
    expect(setValues()).toEqual([
      { status: 'charged', chargedAt: expect.any(Date) },
      { status: 'failed', failureReason: 'PLEDGE_BINDING_MISMATCH' },
    ]);
    expect(whereParams(2)).toEqual(['plg_1', EVENT_ID, 'confirmed', BACKER_DID, 4000, 'CAD', 'seti_1', 'cus_1', 'pm_1', '{}']);
    expect(whereParams(3)).toEqual(['plg_2', EVENT_ID, 'confirmed', BACKER_DID, 2000, 'CAD', 'seti_2', 'cus_2', 'pm_1', '{}']);
  });

  it('rejects missing failure codes before any mutation', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [{ pledgeId: 'plg_2', status: 'failed' }] }));

    expect((await settle()).status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('settles a campaign that has no target once anything is confirmed', async () => {
    queueSettleable(null);
    fetchMock.mockResolvedValue(jsonResponse(200, chargedResults()));

    const res = await settle();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a pay response with no per-pledge results', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, { charged: 2 }));

    const res = await settle();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: ERR_CHARGE_FAILED });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns a generic 503 without logging upstream error prose', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'stripe_unavailable' }));

    const res = await settle();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: ERR_CHARGE_FAILED });
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the pay service failure has no JSON body', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(textResponse(502, '<html>', 'Bad Gateway'));

    const res = await settle();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: ERR_CHARGE_FAILED });
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('answers 503 when the pay service cannot be reached', async () => {
    queueSettleable();
    fetchMock.mockRejectedValue(new Error('boom'));

    const res = await settle();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: ERR_CHARGE_FAILED });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('answers 500 when a pledge status update fails after charging', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, chargedResults()));
    nextUpdate(new Error('boom'));

    const res = await settle();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_SETTLE_FAILED });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'Campaign settle error');
  });
});

describe('POST /api/campaign/{eventId}/cancel', () => {
  beforeEach(() => {
    resetCampaignMocks();
  });

  itAnswersPreflight(cancelOptions);
  itRateLimits(() => cancel(), 10);
  itRejectsUnauthenticated(() => cancel());
  itRejectsMissingEventId(() => cancel(''));
  itRejectsUnknownEvent(() => cancel());
  itRejectsNonCampaignEvent(() => cancel());
  itRejectsNonCreator(() => cancel(), 'Only the campaign creator can cancel');
  itAnswers500WhenHandlerThrows(() => cancel(), () => nextSelect(new Error('boom')), {
    error: 'Failed to cancel campaign',
    logMessage: 'Campaign cancel error',
  });

  it('cancels the open pledges, marks the event cancelled and reports the count', async () => {
    nextSelect([makeEvent()]);
    nextUpdate([{ id: 'plg_1' }, { id: 'plg_2' }]);

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: 2 });
    expectCors(res);
    expect(updatedTables()).toEqual([pledges, events]);
    expect(setValues()).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(whereParams(1)).toEqual([EVENT_ID]);
    expect(whereParams(2)).toEqual([EVENT_ID]);
  });

  it('still cancels the event when there were no open pledges', async () => {
    nextSelect([makeEvent()]);

    const res = await cancel();

    expect(await res.json()).toEqual({ cancelled: 0 });
    expect(updatedTables()).toEqual([pledges, events]);
  });

  it('answers 500 when the event status update fails', async () => {
    nextSelect([makeEvent()]);
    nextUpdate([]);
    nextUpdate(new Error('boom'));

    const res = await cancel();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to cancel campaign' });
  });
});
