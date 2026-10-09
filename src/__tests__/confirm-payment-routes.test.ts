/**
 * Tests for the thin confirm-payment routes:
 *   app/api/orders/[id]/confirm-payment/route.ts
 *   app/api/tickets/[id]/confirm-payment/route.ts
 *
 * The rules are covered in services/order-confirmation.test.ts; these check the
 * HTTP mapping (status codes, bodies, cookie forwarding) over the real service
 * with the drizzle chain mocked. The event lookup is queued empty so the
 * buyer-email block (a separate, fully unit-tested module) is skipped.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CALLER_COOKIE,
  ORGANIZER_DID,
  isEventOrganizerMock,
  itReturns401WhenAuthFails,
  makeRequest,
  nextReturning,
  nextSelect,
  publishMock,
  resetTicketRouteMocks,
  selectMock,
  updatedTables,
} from './support/ticket-route-support';
import { orders, ticketTypes, tickets } from '@/db';
import { POST as confirmOrder } from '../../app/api/orders/[id]/confirm-payment/route';
import { POST as confirmTicket } from '../../app/api/tickets/[id]/confirm-payment/route';

const ORDER_ID = 'ord_1';
const TICKET_ID = 'tkt_1';
const EVENT = 'evt_1';

const order = (status = 'pending') => ({ id: ORDER_ID, eventId: EVENT, status });
const ticket = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  eventId: EVENT,
  orderId: ORDER_ID,
  ticketTypeId: 'type_1',
  ownerDid: 'did:imajin:buyer',
  status: 'held',
  paymentMethod: 'etransfer',
  pricePaid: 1000,
  currency: 'CAD',
  ...overrides,
});

const callOrder = () =>
  confirmOrder(makeRequest(`/api/orders/${ORDER_ID}/confirm-payment`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
const callTicket = () =>
  confirmTicket(makeRequest(`/api/tickets/${TICKET_ID}/confirm-payment`), {
    params: Promise.resolve({ id: TICKET_ID }),
  });

/** Queue what `confirmHeldTickets` reads/writes after the held tickets were found. */
function queueConfirmation(confirmed: unknown[]): void {
  nextReturning(confirmed);
  nextSelect([]); // event lookup: none -> skip buyer emails
}

describe('POST /api/orders/[id]/confirm-payment', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callOrder);

  it('returns 404 for an unknown order', async () => {
    nextSelect([]);

    const res = await callOrder();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Order not found' });
  });

  it('returns 400 when the order is not pending', async () => {
    nextSelect([order('completed')]);

    const res = await callOrder();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Order is not in pending status' });
  });

  it('returns 403 for non-organizers, forwarding the caller cookie', async () => {
    nextSelect([order()]);
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await callOrder();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized' });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT, ORGANIZER_DID, CALLER_COOKIE);
  });

  it('returns 400 when no held e-Transfer tickets remain', async () => {
    nextSelect([order()]);
    nextSelect([]);

    const res = await callOrder();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No held e-Transfer tickets found in this order' });
  });

  it('confirms the held tickets and completes the order', async () => {
    nextSelect([order()]);
    nextSelect([ticket('tkt_1'), ticket('tkt_2')]);
    queueConfirmation([ticket('tkt_1', { status: 'valid' }), ticket('tkt_2', { status: 'valid' })]);

    const res = await callOrder();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmedCount: 2, orderId: ORDER_ID, tickets: ['tkt_1', 'tkt_2'] });
    expect(updatedTables()).toEqual([tickets, orders, ticketTypes]);
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  it('returns 500 when something unexpected fails', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callOrder();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to confirm payment' });
  });
});

describe('POST /api/tickets/[id]/confirm-payment', () => {
  beforeEach(resetTicketRouteMocks);

  itReturns401WhenAuthFails(callTicket);

  it('returns 404 for an unknown ticket', async () => {
    nextSelect([]);

    const res = await callTicket();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Ticket not found' });
  });

  it('returns 400 when the ticket is not held', async () => {
    nextSelect([ticket(TICKET_ID, { status: 'valid' })]);

    const res = await callTicket();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Ticket is not in held status' });
  });

  it('returns 400 when the hold is not an e-Transfer', async () => {
    nextSelect([ticket(TICKET_ID, { paymentMethod: 'stripe' })]);

    const res = await callTicket();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Ticket is not an e-Transfer hold' });
  });

  it('returns 403 for non-organizers, forwarding the caller cookie', async () => {
    nextSelect([ticket(TICKET_ID)]);
    isEventOrganizerMock.mockResolvedValue({ authorized: false });

    const res = await callTicket();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized' });
    expect(isEventOrganizerMock).toHaveBeenCalledWith(EVENT, ORGANIZER_DID, CALLER_COOKIE);
  });

  it('confirms every held sibling of the ticket order', async () => {
    nextSelect([ticket(TICKET_ID)]);
    nextSelect([ticket(TICKET_ID), ticket('tkt_2')]);
    queueConfirmation([ticket(TICKET_ID, { status: 'valid' }), ticket('tkt_2', { status: 'valid' })]);

    const res = await callTicket();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ticket: { id: TICKET_ID, status: 'valid' },
      confirmedCount: 2,
      orderId: ORDER_ID,
    });
  });

  it('confirms an orphan ticket on its own', async () => {
    nextSelect([ticket(TICKET_ID, { orderId: null })]);
    queueConfirmation([ticket(TICKET_ID, { orderId: null, status: 'valid' })]);

    const res = await callTicket();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ confirmedCount: 1, orderId: null });
    expect(updatedTables()).toEqual([tickets, ticketTypes]); // no order to complete
  });

  it('returns 500 when something unexpected fails', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res = await callTicket();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to confirm payment' });
  });
});
