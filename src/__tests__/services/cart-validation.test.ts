import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  TYPE_ID,
  makeTicketType,
  resetOrdersMocks,
} from '@/__tests__/support/orders-support';

vi.mock('@/repositories/ticket-types-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ticketTypesRepositoryMock(),
);
vi.mock('@/repositories/tickets-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ticketsRepositoryMock(),
);

import { findTicketTypesByEvent } from '@/repositories/ticket-types-repository';
import { releaseExpiredHolds } from '@/repositories/tickets-repository';
import { validateCart } from '@/services/cart-validation';
import { ServiceError } from '@/services/errors';

const OTHER_TYPE = 'type_2';

function stockTypes(...types: ReturnType<typeof makeTicketType>[]): void {
  vi.mocked(findTicketTypesByEvent).mockResolvedValue(types);
}

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

beforeEach(() => {
  resetOrdersMocks();
  stockTypes(makeTicketType());
  vi.mocked(releaseExpiredHolds).mockResolvedValue(undefined);
});

describe('validateCart', () => {
  it('computes totals, quantity and currency from the ticket types', async () => {
    stockTypes(makeTicketType({ price: 5000 }), makeTicketType({ id: OTHER_TYPE, price: 2500 }));

    const result = await validateCart(EVENT_ID, [
      { ticketTypeId: TYPE_ID, quantity: 2 },
      { ticketTypeId: OTHER_TYPE, quantity: 1 },
    ]);

    expect(result).toMatchObject({ totalQuantity: 3, totalAmount: 12500, currency: 'CAD' });
    expect([...result.typesById.keys()]).toEqual([TYPE_ID, OTHER_TYPE]);
    expect(findTicketTypesByEvent).toHaveBeenCalledWith(EVENT_ID);
  });

  it('404s for a ticket type that does not belong to the event', async () => {
    const error = await failure(validateCart(EVENT_ID, [{ ticketTypeId: 'nope', quantity: 1 }]));

    expect(error.status).toBe(404);
    expect(error.message).toBe('Ticket type nope not found for this event');
  });

  it('rejects carts mixing currencies', async () => {
    stockTypes(makeTicketType(), makeTicketType({ id: OTHER_TYPE, currency: 'USD' }));

    const error = await failure(
      validateCart(EVENT_ID, [
        { ticketTypeId: TYPE_ID, quantity: 1 },
        { ticketTypeId: OTHER_TYPE, quantity: 1 },
      ]),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe('All tickets in a cart must use the same currency');
  });

  it('skips the max-per-order and availability checks unless asked', async () => {
    stockTypes(makeTicketType({ quantity: 1, maxPerOrder: 1 }));

    await expect(
      validateCart(EVENT_ID, [{ ticketTypeId: TYPE_ID, quantity: 5 }]),
    ).resolves.toMatchObject({ totalQuantity: 5 });
  });

  it('does not release holds unless asked', async () => {
    await validateCart(EVENT_ID, [{ ticketTypeId: TYPE_ID, quantity: 1 }]);

    expect(releaseExpiredHolds).not.toHaveBeenCalled();
  });

  it('releases expired holds for every cart item before checking availability', async () => {
    stockTypes(makeTicketType(), makeTicketType({ id: OTHER_TYPE }));

    await validateCart(
      EVENT_ID,
      [
        { ticketTypeId: TYPE_ID, quantity: 1 },
        { ticketTypeId: OTHER_TYPE, quantity: 1 },
      ],
      { releaseExpiredHolds: true },
    );

    expect(releaseExpiredHolds).toHaveBeenCalledTimes(2);
    expect(releaseExpiredHolds).toHaveBeenCalledWith(TYPE_ID, expect.any(Date));
    expect(releaseExpiredHolds).toHaveBeenCalledWith(OTHER_TYPE, expect.any(Date));
  });

  describe('max per order', () => {
    const options = { checkMaxPerOrder: true };
    const cartOf = (quantity: number) => [{ ticketTypeId: TYPE_ID, quantity }];

    it('uses the ticket type limit first', async () => {
      stockTypes(makeTicketType({ maxPerOrder: 4 }));

      const error = await failure(
        validateCart(EVENT_ID, cartOf(5), { ...options, eventMetadata: { maxTicketsPerOrder: 8 } }),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe('Maximum 4 tickets per order');
    });

    it('falls back to the event metadata limit', async () => {
      const error = await failure(
        validateCart(EVENT_ID, cartOf(7), { ...options, eventMetadata: { maxTicketsPerOrder: 6 } }),
      );

      expect(error.message).toBe('Maximum 6 tickets per order');
    });

    it('defaults to 10 and accepts exactly the limit', async () => {
      await expect(validateCart(EVENT_ID, cartOf(10), options)).resolves.toBeDefined();

      const error = await failure(validateCart(EVENT_ID, cartOf(11), options));
      expect(error.message).toBe('Maximum 10 tickets per order');
    });

    it('caps any configured limit at 20', async () => {
      stockTypes(makeTicketType({ maxPerOrder: 50 }));

      const error = await failure(validateCart(EVENT_ID, cartOf(21), options));

      expect(error.message).toBe('Maximum 20 tickets per order');
    });
  });

  describe('availability', () => {
    const options = { checkAvailability: true };
    const cartOf = (quantity: number) => [{ ticketTypeId: TYPE_ID, quantity }];

    it('treats a null quantity as unlimited', async () => {
      stockTypes(makeTicketType({ quantity: null }));

      await expect(validateCart(EVENT_ID, cartOf(9), options)).resolves.toBeDefined();
    });

    it('accepts a request that exactly fits the remaining stock', async () => {
      stockTypes(makeTicketType({ quantity: 10, sold: 7 }));

      await expect(validateCart(EVENT_ID, cartOf(3), options)).resolves.toBeDefined();
    });

    it('409s with a plural message when several tickets remain', async () => {
      stockTypes(makeTicketType({ quantity: 10, sold: 7 }));

      const error = await failure(validateCart(EVENT_ID, cartOf(4), options));

      expect(error.status).toBe(409);
      expect(error.message).toBe('Only 3 General tickets available');
    });

    it('uses a singular message when one ticket remains', async () => {
      stockTypes(makeTicketType({ quantity: 10, sold: 9 }));

      const error = await failure(validateCart(EVENT_ID, cartOf(2), options));

      expect(error.message).toBe('Only 1 General ticket available');
    });

    it('treats a null sold counter as zero', async () => {
      stockTypes(makeTicketType({ quantity: 2, sold: null }));

      const error = await failure(validateCart(EVENT_ID, cartOf(3), options));

      expect(error.message).toBe('Only 2 General tickets available');
    });

    it('pins the caller-chosen status code for sold-out responses', async () => {
      stockTypes(makeTicketType({ quantity: 1, sold: 1 }));

      const error = await failure(
        validateCart(EVENT_ID, cartOf(1), { ...options, availabilityStatusCode: 400 }),
      );

      expect(error.status).toBe(400);
      expect(error.message).toBe('Only 0 General tickets available');
    });
  });
});
