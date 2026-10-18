import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn().mockResolvedValue(undefined),
  sendOrderOnboard: vi.fn(),
}));
vi.mock('@/db', () => ({ db: {}, ticketTypes: {}, tickets: {}, eventInvites: {} }));
vi.mock('@/lib/auth', () => ({ optionalAuth: vi.fn() }));
vi.mock('@/lib/checkout-common', () => ({ resolveCheckoutIdentity: vi.fn() }));
vi.mock('@/lib/kernel', () => ({ getIdentityTier: vi.fn(), sendOrderOnboard: mocks.sendOrderOnboard }));
vi.mock('@/lib/email', () => ({ generateQRCode: vi.fn().mockResolvedValue('data:qr') }));
vi.mock('@/lib/domain-events', () => ({ publish: mocks.publish }));
vi.mock('@ima-jin/config', () => ({
  eventUrl: (base: string, id: string) => `${base}/e/${id}`,
  eventMyTicketsUrl: (base: string, id: string) => `${base}/e/${id}/my-tickets`,
  eventRegisterUrl: (base: string, id: string, ticket: string) => `${base}/e/${id}/register/${ticket}`,
}));

import { sendFreeConfirmationEmail } from '@/lib/free-checkout-helpers';

describe('free confirmation has no eligible kernel checkout', () => {
  it.each([true, false])('retains ordinary CTA for requiresRegistration=%s without a private send', async (requiresRegistration) => {
    mocks.publish.mockClear();
    await sendFreeConfirmationEmail({
      event: { id: 'evt_free', title: 'Free RSVP', startsAt: '2026-12-01T20:00:00Z' },
      ticketType: { name: 'RSVP', requiresRegistration },
      ticketId: 'tkt_free',
      ownerDid: 'did:imajin:buyer',
      ownerEmail: 'buyer@example.test',
      eventsUrl: 'https://events.test',
      log: { error: vi.fn() } as never,
    });
    expect(mocks.publish).toHaveBeenCalledWith('ticket.confirmed', expect.objectContaining({
      payload: expect.objectContaining({
        magicLink: requiresRegistration
          ? 'https://events.test/e/evt_free/register/tkt_free'
          : 'https://events.test/e/evt_free/my-tickets',
        qrCodeDataUri: 'data:qr',
      }),
    }));
    expect(mocks.sendOrderOnboard).not.toHaveBeenCalled();
  });
});
