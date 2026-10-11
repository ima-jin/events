import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUYER_DID,
  BUYER_EMAIL,
  EVENT_ID,
  ORGANIZER_DID,
  TICKET_ID,
  TYPE_ID,
  logMock,
  publishMock,
  resetOrdersMocks,
} from '@/__tests__/support/orders-support';

const deps = vi.hoisted(() => ({ getContactEmail: vi.fn(), getSurveyResponseForTicket: vi.fn() }));

vi.mock('@ima-jin/logger', async () => (await import('@/__tests__/support/orders-support')).loggerModuleMock());
vi.mock('@/lib/domain-events', async () =>
  (await import('@/__tests__/support/orders-support')).domainEventsModuleMock(),
);
vi.mock('@/lib/kernel', () => ({ getContactEmail: deps.getContactEmail }));
vi.mock('@/lib/ticket-survey', () => ({ getSurveyResponseForTicket: deps.getSurveyResponseForTicket }));
vi.mock('@ima-jin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://events.test',
  eventUrl: (base: string, id: string) => `${base}/e/${id}`,
}));

import type { RefundableTicket } from '@/repositories/tickets-repository';
import {
  buildRefundMessage,
  notifyRefundCustomer,
  type RefundNotificationInput,
} from '@/services/ticket-refund-notification';

const ticket: RefundableTicket = {
  id: TICKET_ID,
  status: 'valid',
  price_paid: 27500,
  payment_id: 'pi_test',
  payment_method: 'stripe',
  ticket_type_id: TYPE_ID,
  owner_did: BUYER_DID,
  currency: 'CAD',
};

function input(overrides: Partial<RefundNotificationInput> = {}): RefundNotificationInput {
  return {
    did: ORGANIZER_DID,
    event: { id: EVENT_ID, title: 'Test Event', imageUrl: null },
    ticket,
    isStripe: true,
    pricePaid: 27500,
    manualRefundRequired: false,
    priceDollars: '275.00',
    currency: 'CAD',
    ...overrides,
  };
}

function publishedPayload(): Record<string, unknown> {
  return (publishMock.mock.calls[0][1] as { payload: Record<string, unknown> }).payload;
}

beforeEach(() => {
  resetOrdersMocks();
  deps.getSurveyResponseForTicket.mockReset().mockResolvedValue(null);
  deps.getContactEmail.mockReset().mockResolvedValue(BUYER_EMAIL);
});

describe('buildRefundMessage', () => {
  it('describes a processed card refund', () => {
    const message = buildRefundMessage('Gig', true, 1000, false, '10.00', 'CAD');

    expect(message).toContain('Your ticket for **Gig** has been refunded.');
    expect(message).toContain('**Amount:** $10.00 CAD');
    expect(message).toContain('5–10 business days');
  });

  it('describes a pending manual e-transfer refund', () => {
    const message = buildRefundMessage('Gig', false, 1000, true, '10.00', 'CAD');

    expect(message).toContain('Your refund for **Gig** is pending.');
    expect(message).toContain('via e-transfer');
  });

  it('treats free (or zero-priced Stripe) tickets as a plain cancellation', () => {
    expect(buildRefundMessage('Gig', false, 0, false, '0.00', 'CAD')).toBe(
      'Your ticket for **Gig** has been cancelled and refunded.',
    );
    expect(buildRefundMessage('Gig', true, 0, false, '0.00', 'CAD')).toContain('cancelled and refunded');
  });
});

describe('notifyRefundCustomer', () => {
  it('publishes ticket.refunded to the owner email and returns it', async () => {
    const email = await notifyRefundCustomer(input());

    expect(email).toBe(BUYER_EMAIL);
    expect(deps.getContactEmail).toHaveBeenCalledWith(BUYER_DID);
    expect(publishMock).toHaveBeenCalledWith('ticket.refunded', expect.objectContaining({
      issuer: ORGANIZER_DID,
      subject: BUYER_DID,
      scope: 'events',
    }));
    expect(publishedPayload()).toMatchObject({
      email: BUYER_EMAIL,
      refundMessage: expect.stringContaining('$275.00 CAD'),
      eventTitle: 'Test Event',
      eventImageUrl: null,
      eventUrl: `https://events.test/e/${EVENT_ID}`,
      manualRefundRequired: false,
      context_id: EVENT_ID,
      context_type: 'event',
    });
  });

  it('prefers the survey response email over the owner lookup', async () => {
    deps.getSurveyResponseForTicket.mockResolvedValue({ answers: { email: 'survey@test.com' } });

    expect(await notifyRefundCustomer(input())).toBe('survey@test.com');
    expect(deps.getSurveyResponseForTicket).toHaveBeenCalledWith(TICKET_ID);
    expect(deps.getContactEmail).not.toHaveBeenCalled();
  });

  it('ignores a survey response without an email', async () => {
    deps.getSurveyResponseForTicket.mockResolvedValue({ answers: {} });

    expect(await notifyRefundCustomer(input())).toBe(BUYER_EMAIL);
  });

  it('returns null and publishes nothing when the ticket has no owner and no survey email', async () => {
    expect(await notifyRefundCustomer(input({ ticket: { ...ticket, owner_did: null } }))).toBeNull();
    expect(deps.getContactEmail).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes nothing when the owner has no resolvable email', async () => {
    deps.getContactEmail.mockResolvedValue(null);

    expect(await notifyRefundCustomer(input())).toBeNull();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('uses an empty subject for a published event whose ticket has no owner but a survey email', async () => {
    deps.getSurveyResponseForTicket.mockResolvedValue({ answers: { email: 'survey@test.com' } });

    await notifyRefundCustomer(input({ ticket: { ...ticket, owner_did: null } }));

    expect(publishMock).toHaveBeenCalledWith('ticket.refunded', expect.objectContaining({ subject: '' }));
  });

  it('absolutizes relative event images and keeps absolute ones', async () => {
    await notifyRefundCustomer(input({ event: { id: EVENT_ID, title: 'T', imageUrl: '/media/c.png' } }));
    expect(publishedPayload().eventImageUrl).toBe('https://events.test/media/c.png');

    publishMock.mockClear();
    await notifyRefundCustomer(input({ event: { id: EVENT_ID, title: 'T', imageUrl: 'https://cdn.test/c.png' } }));
    expect(publishedPayload().eventImageUrl).toBe('https://cdn.test/c.png');
  });

  it('swallows resolution failures (non-fatal) and returns null', async () => {
    deps.getContactEmail.mockRejectedValue(new Error('kernel down'));

    expect(await notifyRefundCustomer(input())).toBeNull();
    expect(logMock.error).toHaveBeenCalledWith(
      { err: 'Error: kernel down' },
      '[refund] Failed to publish refund event (non-fatal)',
    );
  });

  it('logs a rejected publish without failing the notification', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));

    expect(await notifyRefundCustomer(input())).toBe(BUYER_EMAIL);
    await vi.waitFor(() =>
      expect(logMock.error).toHaveBeenCalledWith(
        { err: 'Error: bus down' },
        '[refund] Failed to publish ticket refunded event',
      ),
    );
  });
});
