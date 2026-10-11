/**
 * `validateCart` in lib/checkout-common is the compatibility seam between the
 * orders service (throws ServiceError) and the checkout routes (catch
 * CheckoutValidationError with `statusCode`): responses must stay identical.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ validateCart: vi.fn(), createOrderWithTickets: vi.fn() }));

vi.mock('@/services/orders-service', () => service);
vi.mock('@/lib/auth', () => ({ optionalAuth: vi.fn() }));
vi.mock('@/lib/contact-email', () => ({ getContactEmail: vi.fn(), backfillContactEmail: vi.fn() }));

import { CheckoutValidationError, createOrderWithTickets, validateCart } from '@/lib/checkout-common';
import { ServiceError } from '@/services/errors';

const CART = [{ ticketTypeId: 'type_1', quantity: 1 }];

beforeEach(() => {
  service.validateCart.mockReset();
});

describe('validateCart (checkout-common)', () => {
  it('passes the service result through, forwarding event, items and options', async () => {
    const validated = { totalQuantity: 1 };
    service.validateCart.mockResolvedValue(validated);

    await expect(validateCart('evt_1', CART, { checkAvailability: true })).resolves.toBe(validated);
    expect(service.validateCart).toHaveBeenCalledWith('evt_1', CART, { checkAvailability: true });
  });

  it('defaults the options to an empty object', async () => {
    service.validateCart.mockResolvedValue({});

    await validateCart('evt_1', CART);

    expect(service.validateCart).toHaveBeenCalledWith('evt_1', CART, {});
  });

  it('turns a ServiceError into a CheckoutValidationError with the same message and pinned status', async () => {
    service.validateCart.mockRejectedValue(
      new ServiceError('conflict', 'Only 1 VIP ticket available', { status: 400 }),
    );

    const error = await validateCart('evt_1', CART).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CheckoutValidationError);
    expect(error).toMatchObject({ message: 'Only 1 VIP ticket available', statusCode: 400, field: undefined });
  });

  it('maps default service statuses (404 for a missing ticket type)', async () => {
    service.validateCart.mockRejectedValue(new ServiceError('not_found', 'Ticket type x not found for this event'));

    const error = await validateCart('evt_1', CART).catch((e: unknown) => e);

    expect(error).toMatchObject({ statusCode: 404 });
  });

  it('rethrows unexpected errors untouched', async () => {
    const boom = new Error('db down');
    service.validateCart.mockRejectedValue(boom);

    await expect(validateCart('evt_1', CART)).rejects.toBe(boom);
  });
});

describe('createOrderWithTickets re-export', () => {
  it('is the service implementation', () => {
    expect(createOrderWithTickets).toBe(service.createOrderWithTickets);
  });
});
