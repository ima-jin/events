/**
 * POST /api/campaign/{eventId}/settle and /cancel — the creator-only money
 * actions of a crowdfunding campaign. Shared mocks / blocks live in
 * support/campaign-route-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_ID,
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
import { fetchMock, jsonResponse, payApiKey, payUrl, textResponse } from './support/kernel-mock-support';
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
  amounts.map((amount, index) => makePledge({ id: `plg_${index + 1}`, amount, stripeCustomerId: `cus_${index + 1}` }));

/** Queue the event + confirmed pledges a settle needs to reach the pay service. */
function queueSettleable(targetAmount: number | null = 5000): void {
  nextSelect([makeEvent({ targetAmount })]);
  nextSelect(confirmedPledges());
}

describe('POST /api/campaign/{eventId}/settle', () => {
  beforeEach(() => {
    resetCampaignMocks();
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
        { pledgeId: 'plg_2', status: 'failed', error: 'card_declined' },
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
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${payApiKey}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      eventId: EVENT_ID,
      pledges: [
        { pledgeId: 'plg_1', amount: 4000, currency: 'CAD', stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1' },
        { pledgeId: 'plg_2', amount: 2000, currency: 'CAD', stripeCustomerId: 'cus_2', stripePaymentMethodId: 'pm_1' },
      ],
    });

    expect(updatedTables()).toEqual([pledges, pledges]);
    expect(setValues()).toEqual([
      { status: 'charged', chargedAt: expect.any(Date) },
      { status: 'failed', failureReason: 'card_declined' },
    ]);
    expect(whereParams(2)).toEqual(['plg_1']);
    expect(whereParams(3)).toEqual(['plg_2']);
  });

  it('records a default failure reason when the pay service gives none', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [{ pledgeId: 'plg_2', status: 'failed' }] }));

    await settle();

    expect(setValues()).toEqual([{ status: 'failed', failureReason: 'Charge failed' }]);
  });

  it('settles a campaign that has no target once anything is confirmed', async () => {
    queueSettleable(null);
    fetchMock.mockResolvedValue(jsonResponse(200, { charged: 2, failed: 0, total: 2, results: [] }));

    const res = await settle();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the pay response through untouched when it has no per-pledge results', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, { charged: 2 }));

    const res = await settle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ charged: 2 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('surfaces the pay service error message with a 500', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'stripe_unavailable' }));

    const res = await settle();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'stripe_unavailable' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'stripe_unavailable' }, 'Pay service charge-pledges failed');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the pay service failure has no JSON body', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(textResponse(502, '<html>', 'Bad Gateway'));

    const res = await settle();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_CHARGE_FAILED });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Bad Gateway' }, 'Pay service charge-pledges failed');
  });

  it('answers 500 when the pay service cannot be reached', async () => {
    queueSettleable();
    fetchMock.mockRejectedValue(new Error('boom'));

    const res = await settle();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_SETTLE_FAILED });
  });

  it('answers 500 when a pledge status update fails after charging', async () => {
    queueSettleable();
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [{ pledgeId: 'plg_1', status: 'charged' }] }));
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
