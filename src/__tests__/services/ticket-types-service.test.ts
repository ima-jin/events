import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOKIE,
  EVENT_ID,
  ORGANIZER_DID,
  authorizationMock,
  makeTier,
  repositoryMock as repo,
  resetServiceMocks,
} from '../support/ticket-types-support';

vi.mock('@/repositories/ticket-types-repository', async () => (await import('../support/ticket-types-support')).repositoryMock);
vi.mock('@/services/authorization', async () => (await import('../support/ticket-types-support')).authorizationMock);

import { ServiceError } from '@/services/errors';
import {
  createTier,
  listPublicTiers,
  unlockTiers,
  updateTier,
  type CreateTierBody,
  type UpdateTierBody,
} from '@/services/ticket-types-service';

beforeEach(() => {
  resetServiceMocks();
  repo.listTicketTypeCurrencies.mockResolvedValue([]);
  repo.insertTicketType.mockImplementation(async (values: object) => ({ ...makeTier(), ...values }));
});

async function expectServiceError(promise: Promise<unknown>, status: number, message: string, details?: object) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ status, message });
  if (details) expect((error as ServiceError).details).toEqual(details);
}

const create = (body: CreateTierBody | (() => Promise<CreateTierBody>), cookie: string | null | undefined = COOKIE) =>
  createTier({
    eventId: EVENT_ID,
    actorDid: ORGANIZER_DID,
    callerCookie: cookie,
    readBody: typeof body === 'function' ? body : async () => body,
  });

const update = (body: UpdateTierBody | (() => Promise<UpdateTierBody>)) =>
  updateTier({
    eventId: EVENT_ID,
    actorDid: ORGANIZER_DID,
    callerCookie: COOKIE,
    readBody: typeof body === 'function' ? body : async () => body,
  });

describe('listPublicTiers', () => {
  it('adds remaining availability, null for unlimited tiers and treating null sold as 0', async () => {
    repo.listPublicTicketTypes.mockResolvedValue([
      makeTier({ quantity: 100, sold: 30 }),
      makeTier({ id: 'b', quantity: null }),
      makeTier({ id: 'c', quantity: 5, sold: null }),
    ]);

    const tiers = await listPublicTiers(EVENT_ID);

    expect(repo.listPublicTicketTypes).toHaveBeenCalledWith(EVENT_ID);
    expect(tiers.map((t) => t.available)).toEqual([70, null, 5]);
  });

  it('propagates repository failures', async () => {
    repo.listPublicTicketTypes.mockRejectedValue(new Error('db down'));

    await expect(listPublicTiers(EVENT_ID)).rejects.toThrow('db down');
  });
});

describe('unlockTiers', () => {
  it.each([null, undefined, '', '   '])('rejects a missing code (%j)', async (code) => {
    await expectServiceError(unlockTiers(EVENT_ID, code), 400, 'Missing code parameter');
    expect(repo.listTicketTypesByAccessCode).not.toHaveBeenCalled();
  });

  it('returns 404 for a code that matches no tier', async () => {
    repo.listTicketTypesByAccessCode.mockResolvedValue([]);

    await expectServiceError(unlockTiers(EVENT_ID, 'nope'), 404, 'Invalid access code');
  });

  it('looks tiers up by the trimmed code and adds availability', async () => {
    repo.listTicketTypesByAccessCode.mockResolvedValue([makeTier({ accessCode: 'VIP', quantity: 10, sold: 4 })]);

    const tiers = await unlockTiers(EVENT_ID, '  vip ');

    expect(repo.listTicketTypesByAccessCode).toHaveBeenCalledWith(EVENT_ID, 'vip');
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({ accessCode: 'VIP', available: 6 });
  });
});

describe('createTier', () => {
  it('forbids a non-organizer before reading the body', async () => {
    authorizationMock.isEventOrganizer.mockResolvedValue({ authorized: false });
    const readBody = vi.fn();

    await expectServiceError(create(readBody), 403, 'Not authorized');
    expect(authorizationMock.isEventOrganizer).toHaveBeenCalledWith(EVENT_ID, ORGANIZER_DID, COOKIE);
    expect(readBody).not.toHaveBeenCalled();
    expect(repo.insertTicketType).not.toHaveBeenCalled();
  });

  it('requires a name, then a non-negative price', async () => {
    await expectServiceError(create({ price: 100 }), 400, 'name is required');
    await expectServiceError(create({ name: 'A' }), 400, 'price must be >= 0');
    await expectServiceError(create({ name: 'A', price: -1 }), 400, 'price must be >= 0');
    expect(repo.insertTicketType).not.toHaveBeenCalled();
  });

  it('accepts a free tier and applies defaults', async () => {
    const tier = await create({ name: 'Free', price: 0 }, null);

    expect(repo.insertTicketType).toHaveBeenCalledWith({
      id: expect.stringMatching(/^tkt_type_[0-9a-f]{16}$/),
      eventId: EVENT_ID,
      name: 'Free',
      description: undefined,
      price: 0,
      currency: 'CAD',
      quantity: undefined,
      perks: [],
      sortOrder: 0,
      requiresRegistration: false,
      registrationFormId: null,
      accessCode: null,
    });
    expect(tier).toMatchObject({ name: 'Free', price: 0 });
  });

  it('stores the supplied fields, trimming the access code', async () => {
    await create({
      name: 'VIP',
      description: 'Front row',
      price: 9000,
      currency: 'USD',
      quantity: 20,
      perks: ['drink'],
      sortOrder: 2,
      requiresRegistration: true,
      registrationFormId: 'form_1',
      accessCode: '  secret ',
    });

    expect(repo.listTicketTypeCurrencies).not.toHaveBeenCalled();
    expect(repo.insertTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Front row',
        currency: 'USD',
        quantity: 20,
        perks: ['drink'],
        sortOrder: 2,
        requiresRegistration: true,
        registrationFormId: 'form_1',
        accessCode: 'secret',
      }),
    );
  });

  it('stores a blank access code as null', async () => {
    await create({ name: 'A', price: 1, accessCode: '   ' });

    expect(repo.insertTicketType).toHaveBeenCalledWith(expect.objectContaining({ accessCode: null }));
  });

  it("defaults the currency to the event's most common tier currency", async () => {
    repo.listTicketTypeCurrencies.mockResolvedValue(['USD', 'EUR', 'EUR']);

    await create({ name: 'A', price: 1 });

    expect(repo.listTicketTypeCurrencies).toHaveBeenCalledWith(EVENT_ID);
    expect(repo.insertTicketType).toHaveBeenCalledWith(expect.objectContaining({ currency: 'EUR' }));
  });

  it('falls back to CAD when the currency lookup fails', async () => {
    repo.listTicketTypeCurrencies.mockRejectedValue(new Error('db down'));

    await create({ name: 'A', price: 1 });

    expect(repo.insertTicketType).toHaveBeenCalledWith(expect.objectContaining({ currency: 'CAD' }));
  });

  it('propagates body-parse and insert failures', async () => {
    await expect(create(() => Promise.reject(new SyntaxError('bad json')))).rejects.toThrow('bad json');

    repo.insertTicketType.mockRejectedValue(new Error('insert failed'));
    await expect(create({ name: 'A', price: 1 })).rejects.toThrow('insert failed');
  });
});

describe('updateTier', () => {
  const tier = makeTier({ sold: 0, price: 5000, perks: ['a'] });

  beforeEach(() => {
    repo.getTicketTypeForEvent.mockResolvedValue(tier);
    repo.updateTicketType.mockImplementation(async (_id: string, updates: object) => ({ ...tier, ...updates }));
  });

  it('forbids a non-organizer before reading the body', async () => {
    authorizationMock.isEventOrganizer.mockResolvedValue({ authorized: false });
    const readBody = vi.fn();

    await expectServiceError(update(readBody), 403, 'Not authorized');
    expect(readBody).not.toHaveBeenCalled();
  });

  it('requires a tierId', async () => {
    await expectServiceError(update({}), 400, 'tierId is required');
  });

  it('404s for a tier that is not part of the event', async () => {
    repo.getTicketTypeForEvent.mockResolvedValue(null);

    await expectServiceError(update({ tierId: 'tkt_type_x' }), 404, 'Tier not found');
    expect(repo.getTicketTypeForEvent).toHaveBeenCalledWith('tkt_type_x', EVENT_ID);
  });

  it('reports append-only violations with their list', async () => {
    repo.getTicketTypeForEvent.mockResolvedValue(makeTier({ sold: 5, price: 5000, quantity: 100 }));

    await expectServiceError(update({ tierId: 'tkt_type_1', price: 6000, quantity: 2 }), 400, 'Append-only policy violation', {
      violations: [
        'price can only decrease after tickets are sold (current: 5000, requested: 6000)',
        'quantity cannot be less than sold count (sold: 5, requested: 2)',
      ],
    });
    expect(repo.updateTicketType).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing changes, returning the stored tier unwritten', async () => {
    const result = await update({ tierId: 'tkt_type_1' });

    expect(result).toEqual({ tier, changed: false });
    expect(repo.updateTicketType).not.toHaveBeenCalled();
  });

  it('writes the updates and returns the tier with availability', async () => {
    const result = await update({ tierId: 'tkt_type_1', name: 'Renamed', quantity: 50, accessCode: ' code ' });

    expect(repo.updateTicketType).toHaveBeenCalledWith('tkt_type_1', { name: 'Renamed', quantity: 50, accessCode: 'code' });
    expect(result.changed).toBe(true);
    expect(result.tier).toMatchObject({ name: 'Renamed', quantity: 50, available: 50 });
  });

  it('propagates repository failures', async () => {
    repo.updateTicketType.mockRejectedValue(new Error('update failed'));

    await expect(update({ tierId: 'tkt_type_1', name: 'x' })).rejects.toThrow('update failed');
  });
});
