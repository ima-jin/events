// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyerTicketsSection } from '@/components/buyer-tickets/buyer-tickets-section';
import {
  BUYER_QR, REGISTRATION_BASE, buyerResponse, deferredResponse, jsonResponse,
  makeBuyerOrder, makeBuyerTicket, makeReceipt, mockBuyerFetch, mockFetch,
  registrationTicket, renderBuyer, resetBuyerLocation, sendRegistrationMessage,
} from '../support/ui-support';

beforeEach(() => resetBuyerLocation());

describe('buyer ticket orders', () => {
  it('shows a no-tickets state without removing the purchase UI', async () => {
    mockBuyerFetch([]);
    const { user } = renderBuyer();
    expect(await screen.findByText(/don't have any tickets/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Get Tickets' }));
    expect(screen.getByText('Purchase tickets here')).toBeTruthy();
    expect(globalThis.location.hash).toBe('#buy-tickets');
  });

  it('renders one order and its QR through relative paths', async () => {
    const fetchSpy = mockBuyerFetch();
    renderBuyer();
    const order = await screen.findByRole('article', { name: 'Order ord_buyer' });
    expect(within(order).getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(within(order).getByText('CA$20.00')).toBeTruthy();
    expect(within(order).getByText('Valid')).toBeTruthy();
    const qr = await screen.findByRole('img', { name: 'Ticket QR Code tkt_buyer' });
    expect(qr.getAttribute('src')).toBe(BUYER_QR);
    expect(fetchSpy).toHaveBeenCalledWith('/api/events/evt_1/my-ticket', expect.objectContaining({ cache: 'no-store' }));
    expect(fetchSpy).toHaveBeenCalledWith('/api/tickets/tkt_buyer/qr', expect.anything());
    expect(screen.queryByRole('button', { name: /refund|resend/i })).toBeNull();
  });

  it('keeps mixed-type orders and legacy tickets in distinct groups', async () => {
    mockBuyerFetch([
      makeBuyerOrder({ quantity: 2, ticketTypeName: 'General + VIP', tickets: [makeBuyerTicket(), makeBuyerTicket({ id: 'tkt_vip' })] }),
      makeBuyerOrder({ id: 'ord_second', ticketTypeName: '2× Community', totalAmount: 0, tickets: [makeBuyerTicket({ id: 'tkt_free' })] }),
      makeBuyerOrder({ id: 'legacy_ticket', isLegacy: true, ticketTypeName: 'Legacy', totalAmount: null, purchasedAt: null, tickets: [makeBuyerTicket({ id: 'legacy_ticket', ticketType: null })] }),
    ]);
    renderBuyer();
    expect(await screen.findByRole('heading', { name: 'General + VIP' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getAllByText('N/A')).toHaveLength(2);
    expect(await screen.findByRole('img', { name: 'Ticket QR Code legacy_ticket' })).toBeTruthy();
  });

  it('presents used tickets but never mints QR for refunded, held, cancelled or pending tickets', async () => {
    const fetchSpy = mockBuyerFetch([makeBuyerOrder({ tickets: [
      makeBuyerTicket({ id: 'used', status: 'used', usedAt: '2030-01-01T12:00:00Z' }),
      makeBuyerTicket({ id: 'refunded', status: 'refunded' }),
      makeBuyerTicket({ id: 'refund_pending', status: 'refund_pending' }),
      makeBuyerTicket({ id: 'held', status: 'held' }),
      makeBuyerTicket({ id: 'cancelled', status: 'cancelled' }),
      makeBuyerTicket({ id: 'available', status: 'available' }),
      makeBuyerTicket({ id: 'pending', registrationStatus: 'pending' }),
    ] })]);
    renderBuyer();
    expect(await screen.findByText('Checked In')).toBeTruthy();
    expect(screen.getByText(/^Checked in /)).toBeTruthy();
    for (const label of ['Refunded', 'Refund pending', 'Awaiting payment', 'Cancelled', 'Not activated', 'Registration Required']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(await screen.findByRole('img', { name: 'Ticket QR Code used' })).toBeTruthy();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/qr'))).toHaveLength(1);
  });

  it('defaults ticket holders to My Tickets and honors a purchase deep link', async () => {
    resetBuyerLocation('');
    mockBuyerFetch();
    const { user } = renderBuyer();
    await screen.findByRole('article');
    expect(screen.getByRole('tab', { name: 'My Tickets' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'Get More Tickets' }));
    expect(screen.getByText('Purchase tickets here')).toBeTruthy();
    await act(async () => {
      globalThis.location.hash = '#my-tickets';
      globalThis.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByRole('article')).toBeTruthy();
  });

  it('renders one receipt per order in major units, not once per ticket', async () => {
    mockBuyerFetch([makeBuyerOrder({ fairSettlement: makeReceipt(), tickets: [makeBuyerTicket(), makeBuyerTicket({ id: 'two' })] })]);
    const { user } = renderBuyer();
    const summary = await screen.findByText(/\.fair settlement receipt/);
    expect(screen.getAllByText(/\.fair settlement receipt/)).toHaveLength(1);
    await user.click(summary);
    expect(screen.getByText('Protocol fee (10.0%)')).toBeTruthy();
    expect(screen.getByText('CA$18.00')).toBeTruthy();
    expect(screen.getByText('CA$2.00')).toBeTruthy();
    expect(screen.getByText('Total paid')).toBeTruthy();
  });
});

describe('buyer loading and errors', () => {
  it('shows loading, surfaces errors and retries instead of pretending there are no tickets', async () => {
    const response = deferredResponse();
    mockFetch({ '/my-ticket': () => response.promise });
    const { user } = renderBuyer();
    expect(screen.getByRole('status').textContent).toBe('Loading your tickets…');
    await act(async () => response.resolve(jsonResponse({ error: 'Database unavailable' }, 500)));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/don't have any tickets/)).toBeNull();
    mockBuyerFetch();
    await user.click(screen.getByRole('button', { name: 'Retry tickets' }));
    expect(await screen.findByRole('article')).toBeTruthy();
  });

  it('shows QR loading and retries a failed QR independently', async () => {
    const response = deferredResponse();
    mockBuyerFetch(undefined, { '/qr': () => response.promise });
    const { user } = renderBuyer();
    expect(await screen.findByText('Loading QR code…')).toBeTruthy();
    await act(async () => response.resolve(jsonResponse({ error: 'QR unavailable' }, 500)));
    expect(await screen.findByText('QR unavailable')).toBeTruthy();
    mockBuyerFetch();
    await user.click(screen.getByRole('button', { name: 'Retry QR code' }));
    expect(await screen.findByRole('img')).toBeTruthy();
  });

  it('aborts an old event request and does not display its late response', async () => {
    const response = deferredResponse();
    const fetchSpy = mockFetch({ '/evt_1/': () => response.promise, '/evt_2/': () => buyerResponse([]) });
    const { rerender } = renderBuyer();
    const signal = fetchSpy.mock.calls[0][1]?.signal;
    rerender(<BuyerTicketsSection eventId="evt_2"><p>New purchase</p></BuyerTicketsSection>);
    expect(signal?.aborted).toBe(true);
    await screen.findByText(/don't have any tickets/);
    await act(async () => response.resolve(buyerResponse()));
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('uses the configured base path and encodes event and ticket ids', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const fetchSpy = mockBuyerFetch([makeBuyerOrder({ tickets: [makeBuyerTicket({ id: 'ticket/space' })] })]);
    renderBuyer('event/space');
    await screen.findByRole('img');
    expect(fetchSpy).toHaveBeenCalledWith('/events/api/events/event%2Fspace/my-ticket', expect.anything());
    expect(fetchSpy).toHaveBeenCalledWith('/events/api/tickets/ticket%2Fspace/qr', expect.anything());
    vi.unstubAllEnvs();
  });
});

describe('per-ticket attendee registration', () => {
  it('renders the configured form, confirms through register and reveals the QR immediately', async () => {
    const fetchSpy = mockBuyerFetch([makeBuyerOrder({ tickets: [registrationTicket()] })], {
      '/register/': () => jsonResponse({ success: true }),
    });
    const { user } = renderBuyer();
    const iframe = await screen.findByTitle('Attendee registration tkt_buyer');
    expect(iframe.getAttribute('src')).toBe(`${REGISTRATION_BASE}/embed/form_1?ticketId=tkt_buyer`);
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check registration completion' }));
    expect(await screen.findByText('Registration complete')).toBeTruthy();
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.queryByTitle('Attendee registration tkt_buyer')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith('/api/register/tkt_buyer', expect.objectContaining({ method: 'POST' }));
  });

  it('treats 409 as already completed and permits attendee review', async () => {
    mockBuyerFetch([makeBuyerOrder({ tickets: [registrationTicket()] })], { '/register/': () => jsonResponse({}, 409) });
    const { user } = renderBuyer();
    await screen.findByTitle('Attendee registration tkt_buyer');
    await user.click(screen.getByRole('button', { name: 'Check registration completion' }));
    expect(await screen.findByText('Registration complete')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Attendee details/ })).toBeTruthy();
  });

  it('ignores untrusted, other-frame and on-load messages; accepts a fresh completion from its own iframe', async () => {
    const fetchSpy = mockBuyerFetch([makeBuyerOrder({ tickets: [registrationTicket()] })], { '/register/': () => jsonResponse({ success: true }) });
    renderBuyer();
    const iframe = await screen.findByTitle<HTMLIFrameElement>('Attendee registration tkt_buyer');
    await act(async () => {
      sendRegistrationMessage(iframe, { type: 'survey-completed', answers: {} }, 'https://evil.test');
      sendRegistrationMessage(iframe, { type: 'survey-completed', answers: {} }, 'https://forms.test', false);
      sendRegistrationMessage(iframe, { type: 'survey-completed' });
      sendRegistrationMessage(iframe, null);
    });
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/register/'))).toHaveLength(0);
    await act(async () => sendRegistrationMessage(iframe, { type: 'survey-completed', answers: { name: 'Buyer' } }));
    expect(await screen.findByText('Registration complete')).toBeTruthy();
  });

  it('keeps forms outside the QR grid and resizes only from its own trusted iframe', async () => {
    mockBuyerFetch([makeBuyerOrder({ tickets: [registrationTicket()] })]);
    renderBuyer();
    const iframe = await screen.findByTitle<HTMLIFrameElement>('Attendee registration tkt_buyer');
    expect(iframe.closest('.grid')).toBeNull();
    expect(iframe.style.height).toBe('600px');
    await act(async () => {
      sendRegistrationMessage(iframe, { type: 'survey-height', height: 800 }, 'https://evil.test');
      sendRegistrationMessage(iframe, { type: 'survey-height', height: '800' });
    });
    expect(iframe.style.height).toBe('600px');
    await act(async () => sendRegistrationMessage(iframe, { type: 'survey-height', height: 800 }));
    expect(iframe.style.height).toBe('840px');
  });

  it('keeps a failed registration pending and lets the buyer retry', async () => {
    mockBuyerFetch([makeBuyerOrder({ tickets: [registrationTicket()] })], { '/register/': () => jsonResponse({ error: 'Cannot register' }, 403) });
    const { user } = renderBuyer();
    await screen.findByTitle('Attendee registration tkt_buyer');
    await user.click(screen.getByRole('button', { name: 'Check registration completion' }));
    expect(await screen.findByText('Cannot register')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    mockBuyerFetch(undefined, { '/register/': () => jsonResponse({ success: true }) });
    await user.click(screen.getByRole('button', { name: 'Retry registration' }));
    expect(await screen.findByRole('img')).toBeTruthy();
  });

  it('explains an unavailable registration form without offering a broken link', async () => {
    mockFetch({ '/my-ticket': () => buyerResponse([makeBuyerOrder({ tickets: [registrationTicket()] })], null) });
    renderBuyer();
    expect(await screen.findByText(/registration form is unavailable/)).toBeTruthy();
    expect(screen.queryByTitle(/Attendee registration/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check registration completion' })).toBeNull();
  });

  it('does not offer registration on dead tickets or tickets marked not required', async () => {
    mockBuyerFetch([makeBuyerOrder({ tickets: [
      registrationTicket({ id: 'refunded', status: 'refunded' }),
      registrationTicket({ id: 'not_required', registrationStatus: 'not_required' }),
    ] })]);
    renderBuyer();
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: /Complete Registration|Attendee details/ })).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
  });
});
