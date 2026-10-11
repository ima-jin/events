/**
 * GET /api/campaign/{eventId}/status | my-pledge | pledges — the read side of a
 * crowdfunding campaign. Shared mocks / blocks live in
 * support/campaign-route-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKER_DID,
  CREATOR_DID,
  EVENT_ID,
  campaignRequest,
  expectCors,
  itAnswers500WhenHandlerThrows,
  itAnswersPreflight,
  itRejectsMissingEventId,
  itRejectsNonCampaignEvent,
  itRejectsNonCreator,
  itRejectsUnauthenticated,
  itRejectsUnknownEvent,
  makeEvent,
  makePledge,
  resetCampaignMocks,
  signInAs,
} from './support/campaign-route-support';
import { nextSelect, selectMock, whereParams } from './support/db-queue-support';
import { requireAuthMock } from './support/route-test-support';
import { GET as getMyPledge, OPTIONS as myPledgeOptions } from '../../app/api/campaign/[eventId]/my-pledge/route';
import { GET as getPledges, OPTIONS as pledgesOptions } from '../../app/api/campaign/[eventId]/pledges/route';
import { GET as getStatus, OPTIONS as statusOptions } from '../../app/api/campaign/[eventId]/status/route';

const status = (eventId = EVENT_ID) => getStatus(campaignRequest(eventId, 'status', 'GET'));
const myPledge = (eventId = EVENT_ID) => getMyPledge(campaignRequest(eventId, 'my-pledge', 'GET'));
const pledgesList = (eventId = EVENT_ID) => getPledges(campaignRequest(eventId, 'pledges', 'GET'));

beforeEach(() => {
  resetCampaignMocks();
});

describe('GET /api/campaign/{eventId}/status', () => {
  itAnswersPreflight(statusOptions);
  itRejectsMissingEventId(() => status(''));
  itRejectsUnknownEvent(() => status());
  itRejectsNonCampaignEvent(() => status());
  itAnswers500WhenHandlerThrows(() => status(), () => nextSelect(new Error('boom')), {
    error: 'Failed to get campaign status',
    logMessage: 'Campaign status error',
  });

  it('is public: it never asks for authentication', async () => {
    nextSelect([makeEvent()]);
    nextSelect([{ totalAmount: 0, count: 0 }]);

    const res = await status();

    expect(res.status).toBe(200);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(requireAuthMock).not.toHaveBeenCalled();
  });

  it('reports funding progress from the confirmed + charged pledges', async () => {
    const deadline = new Date('2030-01-15T12:00:00.000Z');
    nextSelect([makeEvent({ targetAmount: 10_000, deadline })]);
    nextSelect([{ totalAmount: 2550, count: 3 }]);

    const res = await status();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      targetAmount: 10_000,
      currentAmount: 2550,
      pledgeCount: 3,
      deadline: '2030-01-15T12:00:00.000Z',
      percentFunded: 25,
      isFullyFunded: false,
    });
    expectCors(res);
    expect(whereParams(0)).toEqual([EVENT_ID]);
  });

  it('caps percentFunded at 100 and flags an over-funded campaign', async () => {
    nextSelect([makeEvent({ targetAmount: 1000 })]);
    nextSelect([{ totalAmount: 2500, count: 4 }]);

    const body = await (await status()).json();

    expect(body).toMatchObject({ percentFunded: 100, isFullyFunded: true, deadline: null });
  });

  it('reports zero progress when there are no pledge rows', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);

    const body = await (await status()).json();

    expect(body).toMatchObject({ currentAmount: 0, pledgeCount: 0, percentFunded: 0, isFullyFunded: false });
  });

  it('treats a campaign without a target as 0% funded (and trivially fully funded)', async () => {
    nextSelect([makeEvent({ targetAmount: null })]);
    nextSelect([{ totalAmount: 0, count: 0 }]);

    const body = await (await status()).json();

    expect(body).toMatchObject({ targetAmount: 0, percentFunded: 0, isFullyFunded: true });
  });
});

describe('GET /api/campaign/{eventId}/my-pledge', () => {
  beforeEach(() => {
    signInAs(BACKER_DID);
  });

  itAnswersPreflight(myPledgeOptions);
  itRejectsUnauthenticated(() => myPledge());
  itRejectsMissingEventId(() => myPledge(''));
  itAnswers500WhenHandlerThrows(() => myPledge(), () => nextSelect(new Error('boom')), {
    error: 'Failed to get pledge',
    logMessage: 'My pledge error',
  });

  it("returns the caller's pledge for the campaign", async () => {
    const pledge = { id: 'plg_1', amount: 5000, status: 'confirmed' };
    nextSelect([pledge]);

    const res = await myPledge();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pledge });
    expectCors(res);
    expect(whereParams(0)).toEqual([EVENT_ID, BACKER_DID]);
  });

  it('returns null when the caller has not pledged', async () => {
    nextSelect([]);

    const res = await myPledge();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pledge: null });
  });
});

describe('GET /api/campaign/{eventId}/pledges', () => {
  itAnswersPreflight(pledgesOptions);
  itRejectsUnauthenticated(() => pledgesList());
  itRejectsMissingEventId(() => pledgesList(''));
  itRejectsUnknownEvent(() => pledgesList());
  itRejectsNonCreator(() => pledgesList(), 'Only the campaign creator can view pledges');
  itAnswers500WhenHandlerThrows(() => pledgesList(), () => nextSelect(new Error('boom')), {
    error: 'Failed to get pledges',
    logMessage: 'Campaign pledges error',
  });

  it('lists every pledge to the campaign creator', async () => {
    const rows = [makePledge({ id: 'plg_1' }), makePledge({ id: 'plg_2', status: 'pending' })];
    nextSelect([makeEvent({ creatorDid: CREATOR_DID })]);
    nextSelect(rows);

    const res = await pledgesList();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pledges: rows });
    expectCors(res);
    expect(whereParams(1)).toEqual([EVENT_ID]);
  });

  it('returns an empty list for a campaign nobody pledged to', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);

    expect(await (await pledgesList()).json()).toEqual({ pledges: [] });
  });
});
