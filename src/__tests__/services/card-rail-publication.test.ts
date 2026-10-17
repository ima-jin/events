import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_DID, EVENT_DID, makeEventRow, makeTicketTypeRow, repoMocks, resetServiceMocks, serviceMocks,
} from '../support/events-support';

vi.mock('@/repositories/events-repository', async () => (await import('../support/events-support')).repoMocks);
vi.mock('@/lib/kernel', async () => (await import('../support/events-support')).kernelModule);
vi.mock('@/lib/domain-events', async () => (await import('../support/events-support')).domainEventsModule);
vi.mock('@ima-jin/logger', async () => (await import('../support/events-support')).loggerModule);
vi.mock('@ima-jin/config', async () => (await import('../support/events-support')).configModule);
vi.mock('@/services/authorization', async () => (await import('../support/events-support')).authorizationModule);
vi.mock('@/lib/card-rail', () => ({ getCardRailReadiness: vi.fn() }));

import { getCardRailReadiness } from '@/lib/card-rail';
import { createEvent, updateEvent, updateEventStatus, type CreateEventInput } from '@/services/events-service';
import { requiresCardRail } from '@/services/card-rail-policy';

const SETUP = 'https://kernel.test/auth/connectors/stripe';
const EVENT_ID = 'evt_1';
const COHOST = 'did:imajin:cohost';
const INPUT: CreateEventInput = {
  title: 'Paid event', startsAt: '2026-12-01T18:00:00.000Z',
  status: 'published', tickets: [{ name: 'General', price: 1000 }],
};
const patch = () => updateEventStatus({ eventId: EVENT_ID, actorDid: CREATOR_DID, status: 'published' });
const put = (body: Record<string, unknown> = { status: 'published' }) =>
  updateEvent({ eventId: EVENT_ID, actorDid: COHOST, body, callerCookie: 'session=cohost' });
const create = (input: CreateEventInput = INPUT) =>
  createEvent({ creatorDid: CREATOR_DID, identityId: CREATOR_DID, input });

beforeEach(() => {
  resetServiceMocks();
  repoMocks.getEventById.mockResolvedValue(makeEventRow());
  repoMocks.listTicketTypesForEvent.mockResolvedValue([makeTicketTypeRow()]);
  repoMocks.updateEventById.mockImplementation(async (id: string, updates: object) => makeEventRow({ id, ...updates }));
  vi.mocked(getCardRailReadiness).mockReset().mockResolvedValue({ cardEnabled: true, setupUrl: SETUP });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ did: EVENT_DID }) }));
});

afterEach(() => vi.unstubAllGlobals());

describe('option-a policy', () => {
  it.each([null, undefined, '', '   '])('requires cards for paid tiers without e-Transfer (%j)', (email) => {
    expect(requiresCardRail(true, email)).toBe(true);
    expect(requiresCardRail(false, email)).toBe(false);
  });

  it('allows e-Transfer without requiring card onboarding', () => {
    expect(requiresCardRail(true, ' seller@example.com ')).toBe(false);
  });
});

describe('explicit create publication', () => {
  it('persists draft and tiers first and publishes only when ready', async () => {
    const result = await create();
    expect(repoMocks.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
    expect(result.event.status).toBe('published');
    expect(result.ticketTypes).toHaveLength(1);
    expect(getCardRailReadiness).toHaveBeenCalledWith(CREATOR_DID);
    expect(repoMocks.insertTicketTypes.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(getCardRailReadiness).mock.invocationCallOrder[0]);
  });

  it.each([
    [false, 409, 'SELLER_NO_CARD_RAIL'],
    [null, 503, 'CARD_RAIL_UNAVAILABLE'],
  ] as const)('keeps the saved draft and paid tiers when readiness is %s', async (cardEnabled, status, code) => {
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled, setupUrl: SETUP });
    const error = await create().catch((err: unknown) => err);
    const saved = repoMocks.insertEvent.mock.calls[0][0];
    expect(error).toMatchObject({ status, details: { code, setupUrl: SETUP, eventId: saved.id } });
    expect(JSON.stringify(error)).not.toContain(saved.privateKey);
    expect(error).not.toHaveProperty('eventKeypair');
    expect(saved.status).toBe('draft');
    expect(repoMocks.insertTicketTypes).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: saved.id, price: 1000 }),
    ]);
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });

  it('leaves a default draft with paid tiers unchecked', async () => {
    const result = await create({ ...INPUT, status: undefined });
    expect(result.event.status).toBe('draft');
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it.each([
    { tickets: [{ name: 'Free', price: 0 }] },
    { tickets: [] },
    { emtEmail: 'seller@example.com' },
  ])('publishes without calling pay for free or e-Transfer events (%j)', async (fields) => {
    expect((await create({ ...INPUT, ...fields })).event.status).toBe('published');
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('rejects unsupported create statuses before persistence', async () => {
    await expect(create({ ...INPUT, status: 'paused' })).rejects.toMatchObject({ status: 400 });
    expect(repoMocks.insertEvent).not.toHaveBeenCalled();
  });
});

describe.each([
  ['PATCH draft', 'draft', patch],
  ['PATCH paused', 'paused', patch],
  ['PUT draft', 'draft', put],
  ['PUT paused', 'paused', put],
] as const)('%s publication', (_label, current, publish) => {
  beforeEach(() => repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: current })));

  it.each([
    [false, 409, 'SELLER_NO_CARD_RAIL'],
    [null, 503, 'CARD_RAIL_UNAVAILABLE'],
  ] as const)('refuses readiness %s and preserves the unpublished event', async (cardEnabled, status, code) => {
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled, setupUrl: SETUP });
    await expect(publish()).rejects.toMatchObject({
      status, details: { code, setupUrl: SETUP, eventId: EVENT_ID },
    });
    expect(getCardRailReadiness).toHaveBeenCalledWith(CREATOR_DID);
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
    expect(serviceMocks.publish).not.toHaveBeenCalled();
  });

  it('permits card-ready paid publication', async () => {
    expect(await publish()).toMatchObject({ status: 'published' });
    expect(getCardRailReadiness).toHaveBeenCalledWith(CREATOR_DID);
  });

  it.each([0, -1])('does not require cards for tiers with price %s', async (price) => {
    repoMocks.listTicketTypesForEvent.mockResolvedValue([makeTicketTypeRow({ price })]);
    await publish();
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('permits e-Transfer even while card readiness is unavailable', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: current, emtEmail: 'seller@example.com' }));
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled: null, setupUrl: SETUP });
    await publish();
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('allows legacy published paid detail saves that resubmit the existing null e-Transfer value', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: 'published', emtEmail: null }));
    await put({ title: 'Renamed', emtEmail: null });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
    expect(repoMocks.updateEventById).toHaveBeenCalled();
  });

  it.each([false, 123, {}, []])('rejects an invalid e-Transfer value (%j) before readiness or writing', async (emtEmail) => {
    await expect(put({ emtEmail })).rejects.toMatchObject({ status: 400 });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });
});

describe('authorization and creator identity', () => {
  it('checks the creator, not the authorized cohost, on PUT publication', async () => {
    await put();
    expect(serviceMocks.isEventOrganizer).toHaveBeenCalledWith(EVENT_ID, COHOST, 'session=cohost');
    expect(getCardRailReadiness).toHaveBeenCalledWith(CREATOR_DID);
    expect(getCardRailReadiness).not.toHaveBeenCalledWith(COHOST);
  });

  it('denies an unauthorized PUT before readiness', async () => {
    serviceMocks.isEventOrganizer.mockResolvedValue({ authorized: false });
    await expect(put()).rejects.toMatchObject({ status: 403 });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('denies a noncreator PATCH before readiness', async () => {
    await expect(updateEventStatus({ eventId: EVENT_ID, actorDid: COHOST, status: 'published' }))
      .rejects.toMatchObject({ status: 403 });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });
});

describe('published event e-Transfer removal', () => {
  beforeEach(() => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: 'published', emtEmail: 'seller@example.com' }));
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled: false, setupUrl: SETUP });
  });

  it.each([null, '', '   '])('refuses removing the last rail (%j)', async (emtEmail) => {
    await expect(put({ emtEmail })).rejects.toMatchObject({
      status: 409, details: { code: 'SELLER_NO_CARD_RAIL', eventId: EVENT_ID },
    });
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable readiness when removing e-Transfer', async () => {
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled: null, setupUrl: SETUP });
    await expect(put({ emtEmail: null })).rejects.toMatchObject({
      status: 503, details: { code: 'CARD_RAIL_UNAVAILABLE', retryable: true },
    });
  });

  it('allows removing e-Transfer when cards work', async () => {
    vi.mocked(getCardRailReadiness).mockResolvedValue({ cardEnabled: true, setupUrl: SETUP });
    await put({ emtEmail: '' });
    expect(repoMocks.updateEventById).toHaveBeenCalledWith(EVENT_ID, expect.objectContaining({ emtEmail: null }));
  });

  it.each([
    { title: 'Legacy live event' },
    { status: 'published', title: 'Still live' },
    { emtEmail: 'new-seller@example.com' },
    { emtEmail: null, status: 'paused' },
  ])('preserves legacy live edits or lets the event become unpublished (%j)', async (body) => {
    await put(body);
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('does not require a rail for free events', async () => {
    repoMocks.listTicketTypesForEvent.mockResolvedValue([makeTicketTypeRow({ price: 0 })]);
    await put({ emtEmail: null });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });

  it('uses the new e-Transfer value in a combined publication update', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());
    await put({ status: 'published', emtEmail: 'seller@example.com' });
    expect(getCardRailReadiness).not.toHaveBeenCalled();
  });
});
