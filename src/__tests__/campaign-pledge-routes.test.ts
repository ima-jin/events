/**
 * POST /api/campaign/pledge and POST /api/campaign/pledge/confirm — the backer
 * side of a crowdfunding campaign: create a Stripe SetupIntent through the pay
 * service, then confirm it. Shared mocks / blocks live in
 * support/campaign-route-support.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKER_DID,
  CREATOR_DID,
  ERR_EVENT_ID_REQUIRED,
  ERR_EVENT_NOT_FOUND,
  ERR_NOT_CAMPAIGN,
  EVENT_ID,
  campaignJsonRequest,
  expectCors,
  itAnswers500WhenHandlerThrows,
  itAnswersPreflight,
  itRateLimits,
  itRejectsUnauthenticated,
  makeEvent,
  makePledge,
  resetCampaignMocks,
  signInAs,
} from './support/campaign-route-support';
import { insertMock, nextInsert, nextSelect, nextUpdate, selectMock, setValues, updatedTables, valuesMock } from './support/db-queue-support';
import { fetchMock, jsonResponse, payUrl, textResponse } from './support/kernel-mock-support';
import { mockLog } from './support/route-test-support';
import { pledges } from '@/db';
import { OPTIONS as pledgeOptions, POST as postPledge } from '../../app/api/campaign/pledge/route';
import { OPTIONS as confirmOptions, POST as postConfirm } from '../../app/api/campaign/pledge/confirm/route';

const PLEDGE_PATH = 'pledge';
const CONFIRM_PATH = 'pledge/confirm';
const COOKIE = 'session=abc';
const ERR_PLEDGE_FAILED = 'Failed to create pledge';
const ERR_CONFIRM_FAILED = 'Failed to confirm pledge';
const ERR_AMOUNT = 'amount must be an integer >= 100 (minimum $1.00)';
const SETUP_INTENT = { clientSecret: 'seti_secret', setupIntentId: 'seti_new', customerId: 'cus_new' };

const pledge = (body: unknown = { eventId: EVENT_ID, amount: 2500 }) =>
  postPledge(campaignJsonRequest(PLEDGE_PATH, body, COOKIE));
const confirm = (body: unknown = { pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }) =>
  postConfirm(campaignJsonRequest(CONFIRM_PATH, body));

beforeEach(() => {
  resetCampaignMocks();
  signInAs(BACKER_DID);
});

describe('POST /api/campaign/pledge', () => {
  itAnswersPreflight(pledgeOptions);
  itRateLimits(() => pledge(), 10);
  itRejectsUnauthenticated(() => pledge());
  itAnswers500WhenHandlerThrows(() => pledge(), () => nextSelect(new Error('boom')), {
    error: ERR_PLEDGE_FAILED,
    logMessage: 'Campaign pledge error',
  });

  it('answers 500 for a malformed JSON body (kernel parity: no 400 for bad JSON)', async () => {
    const res = await pledge('{not json');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_PLEDGE_FAILED });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { amount: 2500 }],
    ['empty', { eventId: '', amount: 2500 }],
    ['not a string', { eventId: 42, amount: 2500 }],
  ])('answers 400 when eventId is %s', async (_label, body) => {
    const res = await pledge(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_EVENT_ID_REQUIRED });
    expectCors(res);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['a numeric string', '2500'],
    ['below the $1 minimum', 99],
    ['fractional', 150.5],
    ['negative', -500],
  ])('answers 400 when amount is %s', async (_label, amount) => {
    const res = await pledge({ eventId: EVENT_ID, amount });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_AMOUNT });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts the minimum amount of 100 cents', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge({ eventId: EVENT_ID, amount: 100 });

    expect(res.status).toBe(200);
  });

  it('answers 404 when the event does not exist', async () => {
    nextSelect([]);

    const res = await pledge();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_EVENT_NOT_FOUND });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['event is not a campaign', { eventType: 'standard' }, ERR_NOT_CAMPAIGN],
    ['campaign is not published', { status: 'draft' }, 'Campaign is not available for pledging'],
    ['campaign is past its deadline', { deadline: new Date(Date.now() - 60_000) }, 'Campaign deadline has passed'],
  ])('answers 400 when the %s', async (_label, overrides, error) => {
    nextSelect([makeEvent(overrides)]);

    const res = await pledge();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'charged'])('answers 409 when the backer already has a %s pledge', async (status) => {
    nextSelect([makeEvent()]);
    nextSelect([makePledge({ status })]);

    const res = await pledge();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have an active pledge for this campaign' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates a SetupIntent through the pay service and inserts a pending pledge', async () => {
    nextSelect([makeEvent({ deadline: new Date(Date.now() + 86_400_000) })]);
    nextSelect([]);
    nextInsert();
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pledgeId: expect.stringMatching(/^plg_[0-9a-f]{24}$/), clientSecret: 'seti_secret' });
    expectCors(res);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${payUrl}/api/setup-intent`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Cookie: COOKIE });
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 2500,
      currency: 'CAD',
      metadata: { eventId: EVENT_ID, backerDid: BACKER_DID },
    });
    expect(valuesMock).toHaveBeenCalledWith({
      id: body.pledgeId,
      eventId: EVENT_ID,
      backerDid: BACKER_DID,
      amount: 2500,
      currency: 'CAD',
      stripeSetupIntentId: 'seti_new',
      stripeCustomerId: 'cus_new',
      status: 'pending',
      metadata: {},
    });
  });

  it('forwards an empty Cookie header when the request carries none', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    await postPledge(campaignJsonRequest(PLEDGE_PATH, { eventId: EVENT_ID, amount: 2500 }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Cookie: '' });
  });

  it('re-uses and resets an abandoned pledge instead of inserting a new one', async () => {
    nextSelect([makeEvent()]);
    nextSelect([makePledge({ id: 'plg_old', status: 'pending', metadata: { note: 'kept' } })]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge({ eventId: EVENT_ID, amount: 4000 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pledgeId: 'plg_old', clientSecret: 'seti_secret' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([pledges]);
    expect(setValues()).toEqual([
      {
        amount: 4000,
        stripeSetupIntentId: 'seti_new',
        stripeCustomerId: 'cus_new',
        status: 'pending',
        metadata: { note: 'kept', updatedAt: expect.any(String) },
      },
    ]);
  });

  it('surfaces the pay service error message with a 500', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(402, { error: 'card_declined' }));

    const res = await pledge();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'card_declined' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'card_declined' }, 'Pay service SetupIntent failed');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the pay service failure has no JSON body', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(textResponse(502, 'upstream down', 'Bad Gateway'));

    const res = await pledge();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create payment setup' });
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Bad Gateway' }, 'Pay service SetupIntent failed');
  });

  it('answers 500 when the pay service cannot be reached', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockRejectedValue(new Error('boom'));

    const res = await pledge();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_PLEDGE_FAILED });
  });

  it('answers 500 when the pledge cannot be stored', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    nextInsert(new Error('boom'));
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge();

    expect(res.status).toBe(500);
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'Campaign pledge error');
  });

  it('attributes the pledge to the acting DID', async () => {
    signInAs(CREATOR_DID);
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    await pledge();

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ backerDid: CREATOR_DID }));
  });
});

describe('POST /api/campaign/pledge/confirm', () => {
  itAnswersPreflight(confirmOptions);
  itRateLimits(() => confirm(), 20);
  itRejectsUnauthenticated(() => confirm());
  itAnswers500WhenHandlerThrows(() => confirm(), () => nextSelect(new Error('boom')), {
    error: ERR_CONFIRM_FAILED,
    logMessage: 'Campaign pledge confirm error',
  });

  it('answers 500 for a malformed JSON body', async () => {
    const res = await confirm('{not json');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_CONFIRM_FAILED });
  });

  it.each([
    ['pledgeId', { setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }],
    ['pledgeId', { pledgeId: 7, setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }],
    ['setupIntentId', { pledgeId: 'plg_1', paymentMethodId: 'pm_new' }],
    ['setupIntentId', { pledgeId: 'plg_1', setupIntentId: 7, paymentMethodId: 'pm_new' }],
    ['paymentMethodId', { pledgeId: 'plg_1', setupIntentId: 'seti_1' }],
    ['paymentMethodId', { pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 7 }],
  ])('answers 400 when %s is missing or not a string', async (field, body) => {
    const res = await confirm(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} is required` });
    expectCors(res);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the backer has no such pledge', async () => {
    nextSelect([]);

    const res = await confirm();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Pledge not found' });
    expect(updatedTables()).toEqual([]);
  });

  it('answers 400 when the SetupIntent id does not match the pledge', async () => {
    nextSelect([makePledge({ stripeSetupIntentId: 'seti_other' })]);

    const res = await confirm();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'SetupIntent ID mismatch' });
    expect(updatedTables()).toEqual([]);
  });

  it('marks the pledge confirmed and stores the payment method', async () => {
    nextSelect([makePledge({ status: 'pending', metadata: { updatedAt: 'earlier' } })]);

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, pledge: { id: 'plg_1', amount: 5000, status: 'confirmed' } });
    expectCors(res);
    expect(updatedTables()).toEqual([pledges]);
    expect(setValues()).toEqual([
      {
        status: 'confirmed',
        stripePaymentMethodId: 'pm_new',
        metadata: { updatedAt: 'earlier', confirmedAt: expect.any(String) },
      },
    ]);
  });

  it('answers 500 when the pledge cannot be updated', async () => {
    nextSelect([makePledge()]);
    nextUpdate(new Error('boom'));

    const res = await confirm();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_CONFIRM_FAILED });
  });
});
