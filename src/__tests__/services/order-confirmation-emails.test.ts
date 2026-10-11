import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  BUYER_EMAIL,
  EVENT_ID,
  ORDER_ID,
  TICKET_ID,
  TYPE_ID,
  logMock,
  makeEvent,
  makeOrder,
  makeTicket,
  makeTicketType,
  publishMock,
  resetOrdersMocks,
} from '@/__tests__/support/orders-support';

const kernel = vi.hoisted(() => ({
  createOnboardToken: vi.fn(),
  resolveProfiles: vi.fn(),
  publicServiceUrl: () => 'https://kernel.test/auth',
}));
const generateQRCode = vi.hoisted(() => vi.fn());

vi.mock('@ima-jin/logger', async () => (await import('@/__tests__/support/orders-support')).loggerModuleMock());
vi.mock('@/lib/domain-events', async () =>
  (await import('@/__tests__/support/orders-support')).domainEventsModuleMock(),
);
vi.mock('@/lib/kernel', () => kernel);
vi.mock('@/lib/email', () => ({ generateQRCode }));
vi.mock('@ima-jin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://events.test',
  eventUrl: (base: string, id: string) => `${base}/e/${id}`,
  eventMyTicketsUrl: (base: string, id: string) => `${base}/e/${id}/my-tickets`,
  eventRegisterUrl: (base: string, id: string, ticketId: string) => `${base}/e/${id}/register/${ticketId}`,
}));
vi.mock('@/repositories/orders-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ordersRepositoryMock(),
);
vi.mock('@/repositories/ticket-types-repository', async () =>
  (await import('@/__tests__/support/orders-support')).ticketTypesRepositoryMock(),
);

import { findOrderById } from '@/repositories/orders-repository';
import { findTicketTypesByIds } from '@/repositories/ticket-types-repository';
import { sendConfirmationEmails } from '@/services/order-confirmation-emails';

const MY_TICKETS = `https://events.test/e/${EVENT_ID}/my-tickets`;
const MAGIC_LINK = 'https://kernel.test/auth/api/onboard/verify?token=tok_1';

function payloadOf(type: string): Record<string, unknown> {
  const call = publishMock.mock.calls.find(([eventType]) => eventType === type);
  return (call?.[1] as { payload: Record<string, unknown> }).payload;
}

function stubProfile(email: string | null, displayName: string | null = 'Bea Buyer'): void {
  kernel.resolveProfiles.mockResolvedValue(new Map([[BUYER_DID, { email, displayName }]]));
}

beforeEach(() => {
  resetOrdersMocks();
  kernel.createOnboardToken.mockReset().mockResolvedValue('tok_1');
  stubProfile(BUYER_EMAIL);
  generateQRCode.mockReset().mockResolvedValue('data:qr');
  vi.mocked(findOrderById).mockResolvedValue(makeOrder());
  vi.mocked(findTicketTypesByIds).mockResolvedValue([makeTicketType({ name: 'VIP' })]);
});

describe('sendConfirmationEmails — buyer contact', () => {
  it('skips (with a warning) when no email can be resolved', async () => {
    stubProfile(null);
    vi.mocked(findOrderById).mockResolvedValue(makeOrder({ buyerEmail: null }));

    await sendConfirmationEmails(makeEvent(), [makeTicket()], ORDER_ID);

    expect(logMock.warn).toHaveBeenCalledWith(
      { buyerDid: BUYER_DID, orderId: ORDER_ID },
      'No buyer email available on EMT confirm; skipping receipt + ticket emails',
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("falls back to the order's buyer email when the profile has none", async () => {
    stubProfile(null, null);

    await sendConfirmationEmails(makeEvent(), [makeTicket()], ORDER_ID);

    expect(findOrderById).toHaveBeenCalledWith(ORDER_ID);
    expect(payloadOf('ticket.receipt')).toMatchObject({ email: BUYER_EMAIL, buyerName: undefined });
  });

  it('skips the profile lookup for ownerless tickets and the order lookup for orphans', async () => {
    vi.mocked(findOrderById).mockClear();

    await sendConfirmationEmails(makeEvent(), [makeTicket({ ownerDid: null })], null);

    expect(kernel.resolveProfiles).not.toHaveBeenCalled();
    expect(findOrderById).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('uses the order email for an ownerless ticket that belongs to an order', async () => {
    await sendConfirmationEmails(makeEvent(), [makeTicket({ ownerDid: null })], ORDER_ID);

    expect(payloadOf('ticket.receipt')).toMatchObject({ email: BUYER_EMAIL });
    expect(publishMock).toHaveBeenCalledWith('ticket.receipt', expect.objectContaining({ issuer: '', subject: '' }));
  });
});

describe('sendConfirmationEmails — receipt + bundle', () => {
  it('publishes the receipt and the ticket bundle with a magic link', async () => {
    await sendConfirmationEmails(
      makeEvent({ isVirtual: null, venue: 'The Hall' }),
      [makeTicket({ id: 'tkt_1' }), makeTicket({ id: 'tkt_2' })],
      ORDER_ID,
    );

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith('ticket.receipt', expect.objectContaining({ issuer: BUYER_DID, subject: BUYER_DID, scope: 'events' }));
    expect(payloadOf('ticket.receipt')).toMatchObject({
      email: BUYER_EMAIL,
      buyerName: 'Bea Buyer',
      eventTitle: 'Test Event',
      eventDate: expect.stringContaining('December'),
      ticketSummary: [{ typeName: 'VIP', quantity: 2, unitPrice: expect.stringContaining('275.00') }],
      totalPaid: expect.stringContaining('550.00'),
      paymentMethod: 'E-Transfer',
      registrationUrl: MY_TICKETS,
      eventImageUrl: undefined,
      hasRegistrationRequired: false,
      context_id: EVENT_ID,
      context_type: 'event',
    });
    expect(generateQRCode).toHaveBeenCalledTimes(2);
    expect(payloadOf('ticket.confirmed')).toMatchObject({
      to: BUYER_EMAIL,
      email: BUYER_EMAIL,
      eventTitle: 'Test Event',
      ticketType: 'VIP',
      ticketId: 'tkt_1',
      isVirtual: false,
      venue: 'The Hall',
      price: expect.stringContaining('550.00'),
      magicLink: MAGIC_LINK,
      eventUrl: `https://events.test/e/${EVENT_ID}`,
      tickets: [
        { id: 'tkt_1', qrCodeDataUri: 'data:qr' },
        { id: 'tkt_2', qrCodeDataUri: 'data:qr' },
      ],
      context_id: EVENT_ID,
      context_type: 'event',
    });
  });

  it('falls back to the my-tickets page when the kernel mints no onboard token', async () => {
    kernel.createOnboardToken.mockResolvedValue(null);

    await sendConfirmationEmails(makeEvent(), [makeTicket()], ORDER_ID);

    expect(payloadOf('ticket.confirmed').magicLink).toBe(MY_TICKETS);
    expect(payloadOf('ticket.receipt').registrationUrl).toBe(MY_TICKETS);
  });

  it('points the receipt at the magic link and holds pending-registration tickets out of the bundle', async () => {
    await sendConfirmationEmails(
      makeEvent(),
      [makeTicket({ id: 'tkt_1' }), makeTicket({ id: 'tkt_2', registrationStatus: 'pending' })],
      ORDER_ID,
    );

    expect(payloadOf('ticket.receipt')).toMatchObject({ registrationUrl: MAGIC_LINK, hasRegistrationRequired: true });
    expect((payloadOf('ticket.confirmed').tickets as { id: string }[]).map((t) => t.id)).toEqual(['tkt_1']);
  });

  it('sends the register url when registration is pending and there is no onboard token', async () => {
    kernel.createOnboardToken.mockResolvedValue(null);

    await sendConfirmationEmails(
      makeEvent(),
      [makeTicket({ id: TICKET_ID, registrationStatus: 'pending' })],
      ORDER_ID,
    );

    expect(payloadOf('ticket.receipt').registrationUrl).toBe(
      `https://events.test/e/${EVENT_ID}/register/${TICKET_ID}`,
    );
  });

  it('publishes no bundle when every ticket still needs registration', async () => {
    await sendConfirmationEmails(
      makeEvent(),
      [makeTicket({ registrationStatus: 'pending' })],
      ORDER_ID,
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('ticket.receipt', expect.anything());
    expect(generateQRCode).not.toHaveBeenCalled();
  });

  it('absolutizes relative event images and keeps absolute ones', async () => {
    await sendConfirmationEmails(makeEvent({ imageUrl: '/media/cover.png' }), [makeTicket()], ORDER_ID);
    expect(payloadOf('ticket.receipt').eventImageUrl).toBe('https://events.test/media/cover.png');

    publishMock.mockClear();
    await sendConfirmationEmails(makeEvent({ imageUrl: 'https://cdn.test/c.png' }), [makeTicket()], ORDER_ID);
    expect(payloadOf('ticket.confirmed').eventImageUrl).toBe('https://cdn.test/c.png');
  });

  it('summarises mixed types and falls back for unknown types and missing prices', async () => {
    vi.mocked(findTicketTypesByIds).mockResolvedValue([makeTicketType({ id: TYPE_ID, name: 'VIP', price: 9000 })]);

    await sendConfirmationEmails(
      makeEvent(),
      [
        makeTicket({ id: 'tkt_1', ticketTypeId: TYPE_ID, pricePaid: null, currency: null }),
        makeTicket({ id: 'tkt_2', ticketTypeId: 'type_gone', pricePaid: null, currency: null }),
      ],
      ORDER_ID,
    );

    expect(findTicketTypesByIds).toHaveBeenCalledWith([TYPE_ID, 'type_gone']);
    expect(payloadOf('ticket.receipt').ticketSummary).toEqual([
      { typeName: 'VIP', quantity: 1, unitPrice: expect.stringContaining('90.00') },
      { typeName: 'Ticket', quantity: 1, unitPrice: expect.stringContaining('0.00') },
    ]);
    expect(payloadOf('ticket.receipt').totalPaid).toEqual(expect.stringContaining('90.00'));
  });

  it('names the bundle ticket type "Ticket" when its type row is gone and uses the buyer email as subject', async () => {
    vi.mocked(findTicketTypesByIds).mockResolvedValue([]);

    await sendConfirmationEmails(makeEvent(), [makeTicket({ ownerDid: '' })], ORDER_ID);

    expect(payloadOf('ticket.confirmed').ticketType).toBe('Ticket');
    expect(publishMock).toHaveBeenCalledWith(
      'ticket.confirmed',
      expect.objectContaining({ issuer: '', subject: BUYER_EMAIL }),
    );
  });

  it('logs (and survives) rejected receipt and bundle publishes', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));

    await sendConfirmationEmails(makeEvent(), [makeTicket()], ORDER_ID);

    await vi.waitFor(() => {
      expect(logMock.error).toHaveBeenCalledWith({ err: 'Error: bus down' }, 'Receipt publish error');
      expect(logMock.error).toHaveBeenCalledWith(
        { err: 'Error: bus down' },
        'Failed to publish ticket confirmed event',
      );
    });
  });
});
