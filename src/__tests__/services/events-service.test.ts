import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_URL,
  CHAT_URL,
  CREATOR_DID,
  EVENT_DID,
  makeEventRow,
  makeTicketTypeRow,
  repoMocks,
  resetServiceMocks,
  serviceMocks,
} from '../support/events-support';
import { REGISTRY_NODE_SELF, expectDefaultShares, expectRegistrySourcedShares, fairChainOf } from '../support/fair-manifest-assertions';

vi.mock('@/repositories/events-repository', async () => (await import('../support/events-support')).repoMocks);
vi.mock('@/lib/kernel', async () => (await import('../support/events-support')).kernelModule);
vi.mock('@/lib/domain-events', async () => (await import('../support/events-support')).domainEventsModule);
vi.mock('@ima-jin/logger', async () => (await import('../support/events-support')).loggerModule);
vi.mock('@ima-jin/config', async () => (await import('../support/events-support')).configModule);
vi.mock('@/services/authorization', async () => (await import('../support/events-support')).authorizationModule);

import {
  createEvent,
  findEventByDid,
  getEventWithTicketTypes,
  listCreatorEvents,
  listEvents,
  updateEvent,
  updateEventStatus,
  type CreateEventInput,
} from '@/services/events-service';
import { ServiceError } from '@/services/errors';

const IDENTITY_ID = 'did:imajin:identity';
const VALID_INPUT: CreateEventInput = { title: 'Test Meetup', startsAt: '2026-12-01T18:00:00.000Z' };
const MEMBERS_URL = `${CHAT_URL}/api/d/${encodeURIComponent(EVENT_DID)}/members`;
const CONTEXT_URL = `${CHAT_URL}/api/d/${encodeURIComponent(EVENT_DID)}/context`;

const fetchMock = vi.fn();

function jsonOk(data: unknown) {
  return { ok: true, json: async () => data };
}

function create(input: CreateEventInput = VALID_INPUT) {
  return createEvent({ creatorDid: CREATOR_DID, identityId: IDENTITY_ID, input, correlationId: 'cor_1' });
}

function insertedRow(): Record<string, unknown> {
  return repoMocks.insertEvent.mock.calls[0][0];
}

async function expectServiceError(promise: Promise<unknown>, code: string, status: number, message: string) {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code, status, message });
}

beforeEach(() => {
  resetServiceMocks();
  fetchMock.mockReset().mockResolvedValue(jsonOk({ did: EVENT_DID }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEvent — validation', () => {
  it.each([
    ['title', { startsAt: VALID_INPUT.startsAt }, 'title is required'],
    ['startsAt', { title: 'T' }, 'startsAt is required'],
    ['campaign target (missing)', { ...VALID_INPUT, eventType: 'campaign' }, 'targetAmount must be a positive integer (cents)'],
    ['campaign target (fractional)', { ...VALID_INPUT, eventType: 'campaign', targetAmount: 10.5 }, 'targetAmount must be a positive integer (cents)'],
    ['campaign target (negative)', { ...VALID_INPUT, eventType: 'campaign', targetAmount: -1 }, 'targetAmount must be a positive integer (cents)'],
    ['campaign target (string)', { ...VALID_INPUT, eventType: 'campaign', targetAmount: '100' }, 'targetAmount must be a positive integer (cents)'],
  ])('rejects an invalid body (%s) with 400 before any side effect', async (_label, input, message) => {
    await expectServiceError(create(input as CreateEventInput), 'invalid', 400, message);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(serviceMocks.getNodeSelf).not.toHaveBeenCalled();
    expect(repoMocks.insertEvent).not.toHaveBeenCalled();
  });
});

describe('createEvent — persistence', () => {
  it('persists a draft event owned by the creator and returns the signing keypair', async () => {
    const result = await create({ ...VALID_INPUT, description: 'Hello', tags: ['a'] });

    expect(insertedRow()).toMatchObject({
      did: EVENT_DID,
      creatorDid: CREATOR_DID,
      title: 'Test Meetup',
      description: 'Hello',
      tags: ['a'],
      status: 'draft',
      eventType: 'event',
      targetAmount: null,
      deadline: null,
      nameDisplayPolicy: 'attendee_choice',
      chatEnabled: true,
      locationType: 'physical',
      isVirtual: false,
      endsAt: null,
      timezone: null,
    });
    expect(result.event.id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(result.eventKeypair.publicKey).toBe(result.event.publicKey);
    expect(result.eventKeypair.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ticketTypes).toEqual([]);
    expect(repoMocks.insertTicketTypes).not.toHaveBeenCalled();
  });

  it('keeps the optional fields the caller provided', async () => {
    await create({
      ...VALID_INPUT,
      endsAt: '2026-12-01T20:00:00.000Z',
      timezone: 'America/Toronto',
      courseSlug: 'intro',
      emtEmail: 'emt@example.com',
      imageAssetId: 'asset_1',
      nameDisplayPolicy: 'real_name',
      chatEnabled: false,
    });

    expect(insertedRow()).toMatchObject({
      endsAt: new Date('2026-12-01T20:00:00.000Z'),
      timezone: 'America/Toronto',
      courseSlug: 'intro',
      emtEmail: 'emt@example.com',
      imageAssetId: 'asset_1',
      nameDisplayPolicy: 'real_name',
      chatEnabled: false,
    });
  });

  it.each([
    [{ locationType: 'online' }, 'online', true],
    [{ locationType: 'physical', isVirtual: true }, 'physical', false],
    [{ isVirtual: true }, 'virtual', true],
    [{}, 'physical', false],
  ])('derives the location from %j', async (location, locationType, isVirtual) => {
    await create({ ...VALID_INPUT, ...location });

    expect(insertedRow()).toMatchObject({ locationType, isVirtual });
  });

  it('stores campaign fields only for campaign events', async () => {
    await create({ ...VALID_INPUT, eventType: 'campaign', targetAmount: 100000, deadline: '2026-11-01T00:00:00.000Z' });
    expect(insertedRow()).toMatchObject({ eventType: 'campaign', targetAmount: 100000, deadline: new Date('2026-11-01T00:00:00.000Z') });

    repoMocks.insertEvent.mockClear();
    await create({ ...VALID_INPUT, eventType: 'campaign', targetAmount: 500 });
    expect(insertedRow()).toMatchObject({ eventType: 'campaign', targetAmount: 500, deadline: null });

    repoMocks.insertEvent.mockClear();
    await create({ ...VALID_INPUT, eventType: 'workshop', targetAmount: 500, deadline: '2026-11-01T00:00:00.000Z' });
    expect(insertedRow()).toMatchObject({ eventType: 'workshop', targetAmount: null, deadline: null });
  });

  it('creates the provided ticket types for the new event', async () => {
    const result = await create({
      ...VALID_INPUT,
      tickets: [
        { name: 'General', price: 2000, quantity: 50, currency: 'CAD' },
        { name: 'VIP', price: 5000, quantity: 5, perks: ['front row'] },
      ],
    });

    expect(result.ticketTypes).toHaveLength(2);
    expect(result.ticketTypes[0]).toMatchObject({ eventId: result.event.id, name: 'General', currency: 'CAD', perks: [] });
    expect(result.ticketTypes[0].id).toMatch(/^tkt_type_[0-9a-f]{16}$/);
    expect(result.ticketTypes[1]).toMatchObject({ name: 'VIP', currency: 'USD', perks: ['front row'] });
  });

  it.each([[undefined], [[]], ['not-an-array']])('creates no ticket types for %j', async (tickets) => {
    const result = await create({ ...VALID_INPUT, tickets });

    expect(result.ticketTypes).toEqual([]);
    expect(repoMocks.insertTicketTypes).not.toHaveBeenCalled();
  });
});

describe('createEvent — kernel interaction', () => {
  it('registers the event DID with the auth service using a signed payload', async () => {
    await create();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTH_URL}/api/register`);
    expect(init.method).toBe('POST');
    const registration = JSON.parse(init.body);
    expect(registration).toMatchObject({ scope: 'actor', subtype: 'event', name: 'Test Meetup' });
    expect(registration.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(registration.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('fails with 500 and persists nothing when the kernel rejects the registration', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'bad signature' }) });

    await expectServiceError(create(), 'unavailable', 500, 'Failed to register event DID: bad signature');
    expect(repoMocks.insertEvent).not.toHaveBeenCalled();
    expect(serviceMocks.publish).not.toHaveBeenCalled();
  });

  it('uses the registry-sourced fee config in the persisted .fair manifest', async () => {
    serviceMocks.getNodeSelf.mockResolvedValue(REGISTRY_NODE_SELF);

    const { event } = await create();

    expectRegistrySourcedShares(fairChainOf({ event: event as never }));
  });

  it('falls back to .fair defaults when the registry is unavailable, and never looks up a forest scope', async () => {
    const { event } = await create();

    expectDefaultShares(fairChainOf({ event: event as never }));
    expect(serviceMocks.getForestScopeConfig).not.toHaveBeenCalled();
  });

  it('publishes event.create and event.created for the creator / identity', async () => {
    const { event } = await create();

    expect(serviceMocks.publish).toHaveBeenCalledWith('event.create', {
      issuer: CREATOR_DID,
      subject: CREATOR_DID,
      scope: 'events',
      payload: { eventId: event.id, eventDid: EVENT_DID, title: 'Test Meetup' },
      correlationId: 'cor_1',
    });
    expect(serviceMocks.publish).toHaveBeenCalledWith('event.created', {
      issuer: IDENTITY_ID,
      subject: IDENTITY_ID,
      scope: 'events',
      payload: { eventDid: EVENT_DID, title: 'Test Meetup', context_id: event.id, context_type: 'event' },
    });
  });

  it('still succeeds and logs when publishing fails', async () => {
    serviceMocks.publish.mockRejectedValue(new Error('bus down'));

    const result = await create();

    expect(result.event.id).toBeDefined();
    await vi.waitFor(() => expect(serviceMocks.log.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, 'Publish error'));
  });
});

describe('createEvent — chat', () => {
  it('creates the event chat and syncs its name policy when a chat service is configured', async () => {
    await create({ ...VALID_INPUT, nameDisplayPolicy: 'real_name' });

    const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CHAT_URL));
    expect(chatCalls.map(([url, init]) => [url, init.method])).toEqual([
      [MEMBERS_URL, 'POST'],
      [CONTEXT_URL, 'PATCH'],
    ]);
    expect(JSON.parse(chatCalls[0][1].body)).toEqual({ memberDid: CREATOR_DID, role: 'admin' });
    expect(JSON.parse(chatCalls[1][1].body)).toEqual({ context: { nameDisplayPolicy: 'real_name' } });
    expect(chatCalls[1][1].headers['X-App-DID']).toBe('did:imajin:events-app');
  });

  it('defaults the synced name policy to attendee_choice', async () => {
    await create();

    const contextCall = fetchMock.mock.calls.find(([url]) => url === CONTEXT_URL);
    expect(JSON.parse(contextCall?.[1].body)).toEqual({ context: { nameDisplayPolicy: 'attendee_choice' } });
  });

  it('skips the chat entirely when no chat service is configured', async () => {
    serviceMocks.serviceUrl.mockImplementation((service: string) => (service === 'auth' ? AUTH_URL : null));

    await create();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail creation when the chat service is unreachable', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${AUTH_URL}/api/register`) return jsonOk({ did: EVENT_DID });
      throw new Error('ECONNREFUSED');
    });

    const result = await create();

    expect(result.event.id).toBeDefined();
    expect(serviceMocks.log.warn).toHaveBeenCalledWith({ err: 'Error: ECONNREFUSED' }, 'Event chat creation failed (non-fatal)');
    expect(serviceMocks.log.info).not.toHaveBeenCalled();
  });
});

describe('listEvents', () => {
  const ROW = makeEventRow({ id: 'evt_1', status: 'published', emtEmail: 'emt@example.com' });

  it('defaults to published events and strips the private key for public callers', async () => {
    repoMocks.listEvents.mockResolvedValue([ROW]);

    const result = await listEvents({ limit: 20, audience: 'public' });

    expect(repoMocks.listEvents).toHaveBeenCalledWith({ status: 'published', courseSlug: undefined, upcoming: undefined, limit: 20 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'evt_1', emtEmail: 'emt@example.com' });
    expect(result[0]).not.toHaveProperty('privateKey');
  });

  it('passes the filters through and restricts app callers to the public fields', async () => {
    repoMocks.listEvents.mockResolvedValue([ROW]);

    const result = await listEvents({ status: 'draft', limit: 5, courseSlug: 'intro', upcoming: true, audience: 'app' });

    expect(repoMocks.listEvents).toHaveBeenCalledWith({ status: 'draft', courseSlug: 'intro', upcoming: true, limit: 5 });
    expect(result[0]).toMatchObject({ id: 'evt_1', title: 'Test Meetup' });
    expect(result[0]).not.toHaveProperty('privateKey');
    expect(result[0]).not.toHaveProperty('emtEmail');
  });
});

describe('getEventWithTicketTypes', () => {
  it('returns the event with per-type availability (null = unlimited)', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());
    repoMocks.listTicketTypesForEvent.mockResolvedValue([
      makeTicketTypeRow({ quantity: 10, sold: 4 }),
      makeTicketTypeRow({ id: 'tkt_type_2', quantity: 10, sold: null }),
      makeTicketTypeRow({ id: 'tkt_type_3', quantity: null }),
    ]);

    const result = await getEventWithTicketTypes('evt_1', 'public');

    expect(result.event).not.toHaveProperty('privateKey');
    expect(result.ticketTypes.map((t) => t.available)).toEqual([6, 10, null]);
    expect(repoMocks.listTicketTypesForEvent).toHaveBeenCalledWith('evt_1');
  });

  it('serialises for app callers', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ emtEmail: 'emt@example.com' }));
    repoMocks.listTicketTypesForEvent.mockResolvedValue([]);

    const result = await getEventWithTicketTypes('evt_1', 'app');

    expect(result.event).not.toHaveProperty('emtEmail');
    expect(result.ticketTypes).toEqual([]);
  });

  it('throws 404 for an unknown event', async () => {
    repoMocks.getEventById.mockResolvedValue(null);

    await expectServiceError(getEventWithTicketTypes('evt_x', 'public'), 'not_found', 404, 'Event not found');
    expect(repoMocks.listTicketTypesForEvent).not.toHaveBeenCalled();
  });
});

describe('listCreatorEvents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds sold count, revenue, ticket types and a status badge to each event', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-01T00:00:00.000Z'), toFake: ['Date'] });
    const past = makeEventRow({ id: 'evt_past', status: 'published', startsAt: new Date('2026-01-01T00:00:00.000Z') });
    const live = makeEventRow({ id: 'evt_live', status: 'published', startsAt: new Date('2026-12-01T00:00:00.000Z') });
    const draft = makeEventRow({ id: 'evt_draft', status: 'draft' });
    repoMocks.listEventsByCreator.mockResolvedValue([past, live, draft]);
    repoMocks.listTicketTypesForEvent.mockImplementation(async (eventId: string) =>
      eventId === 'evt_draft'
        ? []
        : [makeTicketTypeRow({ price: 2000, sold: 3 }), makeTicketTypeRow({ price: 500, sold: null })],
    );

    const result = await listCreatorEvents(CREATOR_DID);

    expect(repoMocks.listEventsByCreator).toHaveBeenCalledWith(CREATOR_DID);
    expect(result.map((e) => [e.id, e.statusBadge, e.ticketsSold, e.revenue])).toEqual([
      ['evt_past', 'past', 3, 6000],
      ['evt_live', 'live', 3, 6000],
      ['evt_draft', 'draft', 0, 0],
    ]);
    expect(result[0].ticketTypes).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('privateKey');
  });

  it('returns an empty list when the creator has no events', async () => {
    repoMocks.listEventsByCreator.mockResolvedValue([]);

    expect(await listCreatorEvents(CREATOR_DID)).toEqual([]);
  });
});

describe('findEventByDid', () => {
  it('returns the event summary', async () => {
    const summary = { id: 'evt_1', title: 'Test Meetup', did: EVENT_DID };
    repoMocks.getEventSummaryByDid.mockResolvedValue(summary);

    expect(await findEventByDid(EVENT_DID)).toBe(summary);
    expect(repoMocks.getEventSummaryByDid).toHaveBeenCalledWith(EVENT_DID);
  });

  it('throws 404 when no event has that DID', async () => {
    repoMocks.getEventSummaryByDid.mockResolvedValue(null);

    await expectServiceError(findEventByDid('did:none'), 'not_found', 404, 'Event not found');
  });
});

describe('updateEventStatus', () => {
  const run = (status: unknown, actorDid = CREATOR_DID) => updateEventStatus({ eventId: 'evt_1', actorDid, status });

  it.each([
    ['draft', 'published'],
    ['published', 'paused'],
    ['published', 'cancelled'],
    ['published', 'completed'],
    ['paused', 'published'],
    ['paused', 'cancelled'],
  ])('allows %s → %s, stores it and publishes event.update', async (from, to) => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: from }));
    repoMocks.updateEventById.mockResolvedValue(makeEventRow({ status: to }));

    const result = await run(to);

    expect(result).toMatchObject({ status: to });
    expect(result).not.toHaveProperty('privateKey');
    expect(repoMocks.updateEventById).toHaveBeenCalledWith('evt_1', { status: to, updatedAt: expect.any(Date) });
    expect(serviceMocks.publish).toHaveBeenCalledWith('event.update', {
      issuer: CREATOR_DID,
      subject: CREATOR_DID,
      scope: 'events',
      payload: { eventId: 'evt_1', status: to },
    });
  });

  it.each([
    ['draft', 'paused'],
    ['cancelled', 'published'],
    ['completed', 'published'],
    ['published', 'draft'],
  ])('rejects %s → %s with 400', async (from, to) => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: from }));

    await expectServiceError(run(to), 'invalid', 400, `Cannot transition from "${from}" to "${to}"`);
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });

  it('treats an event with no status as a draft', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: null as unknown as string }));
    repoMocks.updateEventById.mockResolvedValue(makeEventRow({ status: 'published' }));

    expect(await run('published')).toMatchObject({ status: 'published' });
  });

  it('rejects an unknown status on an unrecognised current state', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow({ status: 'archived' }));

    await expectServiceError(run('published'), 'invalid', 400, 'Cannot transition from "archived" to "published"');
  });

  it.each([[undefined], [''], ['bogus'], [7]])('rejects the status %j as invalid', async (status) => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());

    await expectServiceError(run(status), 'invalid', 400, 'Invalid status');
  });

  it('throws 404 for an unknown event', async () => {
    repoMocks.getEventById.mockResolvedValue(null);

    await expectServiceError(run('published'), 'not_found', 404, 'Event not found');
  });

  it('only lets the creator change status (403)', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());

    await expectServiceError(run('published', 'did:imajin:cohost'), 'forbidden', 403, 'Only the event creator can change status');
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });

  it('still succeeds and logs when publishing fails', async () => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());
    repoMocks.updateEventById.mockResolvedValue(makeEventRow({ status: 'published' }));
    serviceMocks.publish.mockRejectedValue(new Error('bus down'));

    await run('published');

    await vi.waitFor(() => expect(serviceMocks.log.error).toHaveBeenCalled());
  });
});

describe('updateEvent', () => {
  const run = (body: Record<string, unknown>, callerCookie?: string | null) =>
    updateEvent({ eventId: 'evt_1', actorDid: CREATOR_DID, body, callerCookie });

  beforeEach(() => {
    repoMocks.getEventById.mockResolvedValue(makeEventRow());
    repoMocks.updateEventById.mockResolvedValue(makeEventRow({ title: 'Renamed' }));
  });

  it('applies the update, publishes event.update and returns the public event', async () => {
    const result = await run({ title: 'Renamed' }, 'session=abc');

    expect(serviceMocks.isEventOrganizer).toHaveBeenCalledWith('evt_1', CREATOR_DID, 'session=abc');
    expect(repoMocks.updateEventById).toHaveBeenCalledWith('evt_1', { title: 'Renamed', updatedAt: expect.any(Date) });
    expect(result).toMatchObject({ title: 'Renamed' });
    expect(result).not.toHaveProperty('privateKey');
    expect(serviceMocks.publish).toHaveBeenCalledWith('event.update', {
      issuer: CREATOR_DID,
      subject: CREATOR_DID,
      scope: 'events',
      payload: { eventId: 'evt_1' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('syncs a changed name display policy to the event chat', async () => {
    await run({ nameDisplayPolicy: 'handle' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CONTEXT_URL);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ context: { nameDisplayPolicy: 'handle' } });
  });

  it('does not sync the policy when no chat service is configured', async () => {
    serviceMocks.serviceUrl.mockReturnValue(null);

    await run({ nameDisplayPolicy: 'handle' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not sync the policy when the update matched no row', async () => {
    repoMocks.updateEventById.mockResolvedValue(undefined);

    await run({ nameDisplayPolicy: 'handle' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid nameDisplayPolicy with 400 before writing', async () => {
    await expectServiceError(run({ nameDisplayPolicy: 'nope' }), 'invalid', 400, 'Invalid nameDisplayPolicy');
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });

  it('throws 404 for an unknown event, before the organizer check', async () => {
    repoMocks.getEventById.mockResolvedValue(null);

    await expectServiceError(run({ title: 'x' }), 'not_found', 404, 'Event not found');
    expect(serviceMocks.isEventOrganizer).not.toHaveBeenCalled();
  });

  it('throws 403 when the actor is not an organizer', async () => {
    serviceMocks.isEventOrganizer.mockResolvedValue({ authorized: false });

    await expectServiceError(run({ title: 'x' }), 'forbidden', 403, 'Not authorized to update this event');
    expect(repoMocks.updateEventById).not.toHaveBeenCalled();
  });
});
