// @vitest-environment jsdom
/** Render + interaction tests for the ticket purchase flow (src/components/tickets/ticket-purchase.tsx). */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  FREE_TIER,
  jsonResponse,
  makeTier,
  makeTierRow,
  mockFetch,
  renderPurchase,
  requestBody,
} from '../support/ui-support';

const NO_CARD_NOTICE = /card payment isn't set up for this event/i;
const GENERAL = 'tier_general';
const SENT_INSTRUCTIONS = {
  email: 'pay@org.ca',
  amount: 40,
  currency: 'CAD',
  memo: 'ORD-77',
  deadline: '2030-01-01T00:00:00Z',
  message: 'Send one e-Transfer for the full amount',
};

type Purchase = ReturnType<typeof renderPurchase>;

async function addTickets(user: Purchase['user'], name = 'General', count = 2) {
  for (let i = 0; i < count; i += 1) {
    await user.click(screen.getByRole('button', { name: `Add one ${name}` }));
  }
}

const ANN = 'ann@example.com';

/** Open the e-Transfer form as an anonymous buyer, fill in an email and submit. */
async function reserveAsAnonymous(user: Purchase['user']) {
  await user.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));
  await user.type(screen.getByLabelText('Your email'), ANN);
  await user.click(screen.getByRole('button', { name: 'Reserve My Tickets' }));
}

/** Open the RSVP form for the free tier as an anonymous visitor, fill in an email and submit. */
async function rsvpAsAnonymous(user: Purchase['user']) {
  await user.click(screen.getByRole('button', { name: 'RSVP for Community' }));
  await user.type(screen.getByLabelText('Your email'), ANN);
  await user.click(screen.getByRole('button', { name: 'Confirm RSVP' }));
}

describe('tier list', () => {
  it('shows name, price, description, perks and a low-stock hint', () => {
    renderPurchase({ tiers: [makeTier({ description: 'Main floor', perks: ['Free drink'], available: 3, quantity: 10 })] });

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(screen.getByText(/20\.00/)).toBeTruthy();
    expect(screen.getByText('Main floor')).toBeTruthy();
    expect(screen.getByText('Free drink')).toBeTruthy();
    expect(screen.getByText('Only 3 left')).toBeTruthy();
  });

  it('tells visitors when there is nothing to buy yet', () => {
    renderPurchase({ tiers: [] });

    expect(screen.getByText('No tickets are available yet.')).toBeTruthy();
  });

  it('shows a sold-out tier with a disabled button and no stepper', () => {
    renderPurchase({ tiers: [makeTier({ available: 0, quantity: 5 })] });

    expect((screen.getByRole('button', { name: 'Sold Out' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add one General' })).toBeNull();
  });

  it('caps the stepper at the stock left and at the tier limit', async () => {
    const { user } = renderPurchase({ tiers: [makeTier({ available: 2, quantity: 5 })] });

    await addTickets(user, 'General', 5);

    expect(within(screen.getByRole('group', { name: 'Quantity for General' })).getByRole('status').textContent).toBe('2');
    expect((screen.getByRole('button', { name: 'Add one General' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('honours the event-wide order cap', async () => {
    const { user } = renderPurchase({ maxTicketsPerOrder: 3 });

    await addTickets(user, 'General', 6);

    expect(screen.getByRole('status').textContent).toBe('3');
  });

  it('shows the running total as tickets are added and removed', async () => {
    const { user } = renderPurchase();
    expect(screen.queryByRole('region', { name: 'Checkout' })).toBeNull();

    await addTickets(user);

    const checkout = screen.getByRole('region', { name: 'Checkout' });
    expect(within(checkout).getByText(/40\.00/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove one General' }));
    expect(within(screen.getByRole('region', { name: 'Checkout' })).getByText(/20\.00/)).toBeTruthy();
  });
});

describe('card rail', () => {
  it('sends the cart (with the invite) to /api/checkout and navigates to the provider, staying busy', async () => {
    const fetchSpy = mockFetch({ '/api/checkout': jsonResponse({ url: '#provider-session' }) });
    const { user } = renderPurchase({ invite: 'INV1' });
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay with Card' }));

    await waitFor(() => expect(globalThis.location.hash).toBe('#provider-session'));
    expect(requestBody(fetchSpy, '/api/checkout')).toEqual({
      eventId: 'evt_1',
      items: [{ ticketTypeId: GENERAL, quantity: 2 }],
      invite: 'INV1',
    });
    expect((screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error and keeps the card button after an ordinary failure', async () => {
    mockFetch({ '/api/checkout': jsonResponse({ error: 'Only 1 General ticket available' }, 409) });
    const { user } = renderPurchase();
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay with Card' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Only 1 General ticket available');
    expect(screen.getByRole('button', { name: 'Pay with Card' })).toBeTruthy();
    expect(screen.queryByText(NO_CARD_NOTICE)).toBeNull();
  });

  it('SELLER_NO_CARD_RAIL: says card payment is not set up and shows NO card button', async () => {
    mockFetch({ '/api/checkout': jsonResponse({ error: 'Seller has no card rail', code: 'SELLER_NO_CARD_RAIL' }, 409) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay with Card' }));

    expect(await screen.findByText(NO_CARD_NOTICE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /card/i })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // the other rails stay on offer
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeTruthy();
  });

  it('SELLER_NO_CARD_RAIL with no other rail explains that nothing can be paid right now', async () => {
    mockFetch({ '/api/checkout': jsonResponse({ error: 'x', code: 'SELLER_NO_CARD_RAIL' }, 409) });
    const { user } = renderPurchase();
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay with Card' }));

    expect(await screen.findByText(NO_CARD_NOTICE)).toBeTruthy();
    expect(screen.getByText(/no payment method is available/i)).toBeTruthy();
  });
});

describe('e-Transfer rail', () => {
  it('is offered only when the organizer accepts e-Transfer', async () => {
    const { user } = renderPurchase();
    await addTickets(user);

    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
  });

  it('asks an anonymous buyer for name + email, then shows the payment instructions', async () => {
    const fetchSpy = mockFetch({ '/api/checkout/etransfer': jsonResponse({ orderId: 'ord_77', instructions: SENT_INSTRUCTIONS }, 201) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));
    const reserve = screen.getByRole('button', { name: 'Reserve My Tickets' }) as HTMLButtonElement;
    expect(reserve.disabled).toBe(true);
    await user.type(screen.getByLabelText('Your name'), 'Ann');
    await user.type(screen.getByLabelText('Your email'), ANN);
    await user.click(reserve);

    expect(await screen.findByText('ORD-77')).toBeTruthy();
    expect(screen.getByText('pay@org.ca')).toBeTruthy();
    expect(screen.getByText('Order ID:', { exact: false }).textContent).toContain('ord_77');
    expect(requestBody(fetchSpy, '/api/checkout/etransfer')).toMatchObject({
      items: [{ ticketTypeId: GENERAL, quantity: 2 }],
      email: ANN,
      name: 'Ann',
    });
  });

  it('lets a signed-in buyer reserve without typing anything', async () => {
    const fetchSpy = mockFetch({
      '/api/balance': jsonResponse({ balance: 0 }),
      '/api/checkout/etransfer': jsonResponse({ orderId: 'ord_78', instructions: SENT_INSTRUCTIONS }, 201),
    });
    const { user } = renderPurchase({ etransferEnabled: true, isAuthenticated: true });
    await addTickets(user);

    await user.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));
    expect(screen.queryByLabelText('Your email')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reserve My Tickets' }));

    expect(await screen.findByText('ORD-77')).toBeTruthy();
    expect(requestBody(fetchSpy, '/api/checkout/etransfer')).not.toHaveProperty('email');
  });

  it('shows the "check your email" verification notice', async () => {
    mockFetch({ '/api/checkout/etransfer': jsonResponse({ verificationSent: true, message: 'We sent a verification link to ann@example.com.' }) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await addTickets(user);

    await reserveAsAnonymous(user);

    expect(await screen.findByText('Check your email')).toBeTruthy();
    expect(screen.getByText(/verification link/)).toBeTruthy();
  });

  it('shows a reservation error inside the form and lets the buyer go back', async () => {
    mockFetch({ '/api/checkout/etransfer': jsonResponse({ error: 'Only 1 General ticket available' }, 409) });
    const { user } = renderPurchase({ etransferEnabled: true });
    await addTickets(user);

    await reserveAsAnonymous(user);

    expect((await screen.findByRole('alert')).textContent).toBe('Only 1 General ticket available');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Add one General' })).toBeTruthy();
  });
});

describe('balance rail', () => {
  it('is offered to signed-in buyers whose balance covers the total, and completes the order', async () => {
    const fetchSpy = mockFetch({
      '/api/balance': jsonResponse({ balance: 100, currency: 'CAD' }),
      '/api/checkout/balance': jsonResponse({ success: true, orderId: 'ord_bal' }),
    });
    const { user } = renderPurchase({ isAuthenticated: true });
    await addTickets(user);

    await user.click(await screen.findByRole('button', { name: /Pay with Balance/ }));

    expect(await screen.findByText('Payment complete')).toBeTruthy();
    expect(screen.getByText(/ord_bal/)).toBeTruthy();
    expect(requestBody(fetchSpy, '/api/checkout/balance')).toMatchObject({ items: [{ ticketTypeId: GENERAL, quantity: 2 }] });
  });

  it('is hidden when the balance does not cover the total', async () => {
    const fetchSpy = mockFetch({ '/api/balance': jsonResponse({ balance: 5 }) });
    const { user } = renderPurchase({ isAuthenticated: true });
    await addTickets(user);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Pay with Balance/ })).toBeNull();
  });

  it('is never requested for anonymous visitors', async () => {
    const fetchSpy = mockFetch({});
    const { user } = renderPurchase();
    await addTickets(user);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the balance checkout error', async () => {
    mockFetch({
      '/api/balance': jsonResponse({ balance: 100 }),
      '/api/checkout/balance': jsonResponse({ error: 'Balance checkout failed' }, 500),
    });
    const { user } = renderPurchase({ isAuthenticated: true });
    await addTickets(user);

    await user.click(await screen.findByRole('button', { name: /Pay with Balance/ }));

    expect((await screen.findByRole('alert')).textContent).toBe('Balance checkout failed');
  });
});

describe('free tiers', () => {
  it('asks an anonymous visitor for an email, RSVPs and confirms', async () => {
    const fetchSpy = mockFetch({ '/api/checkout/free': jsonResponse({ success: true, ticketId: 't1' }) });
    const { user } = renderPurchase({ tiers: [FREE_TIER], invite: 'INV2' });
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add one Community' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'RSVP for Community' }));
    await user.type(screen.getByLabelText('Your name'), 'Ann');
    await user.type(screen.getByLabelText('Your email'), ANN);
    await user.click(screen.getByRole('button', { name: 'Confirm RSVP' }));

    expect(await screen.findByText("You're in!")).toBeTruthy();
    expect(requestBody(fetchSpy, '/api/checkout/free')).toEqual({
      eventId: 'evt_1',
      ticketTypeId: 'tier_free',
      invite: 'INV2',
      email: ANN,
      name: 'Ann',
    });
  });

  it('RSVPs a signed-in visitor with a single click', async () => {
    mockFetch({ '/api/balance': jsonResponse({ balance: 0 }), '/api/checkout/free': jsonResponse({ success: true }) });
    const { user } = renderPurchase({ tiers: [FREE_TIER], isAuthenticated: true });

    await user.click(screen.getByRole('button', { name: 'RSVP for Community' }));

    expect(await screen.findByText("You're in!")).toBeTruthy();
  });

  it('falls back to the email form when the server cannot resolve a signed-in buyer\'s email', async () => {
    mockFetch({
      '/api/balance': jsonResponse({ balance: 0 }),
      '/api/checkout/free': jsonResponse({ error: 'Please provide an email address to RSVP' }, 400),
    });
    const { user } = renderPurchase({ tiers: [FREE_TIER], isAuthenticated: true });

    await user.click(screen.getByRole('button', { name: 'RSVP for Community' }));

    expect(await screen.findByLabelText('Your email')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/email address/);
  });

  it('shows RSVP errors and lets the buyer go back', async () => {
    mockFetch({ '/api/checkout/free': jsonResponse({ error: 'Event is not published' }, 400) });
    const { user } = renderPurchase({ tiers: [FREE_TIER] });

    await rsvpAsAnonymous(user);

    expect((await screen.findByRole('alert')).textContent).toBe('Event is not published');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'RSVP for Community' })).toBeTruthy();
  });

  it('shows the busy label while the RSVP is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    mockFetch({ '/api/checkout/free': () => new Promise<Response>((resolve) => { release = resolve; }) });
    const { user } = renderPurchase({ tiers: [FREE_TIER] });

    await rsvpAsAnonymous(user);

    expect((screen.getByRole('button', { name: 'Confirming…' }) as HTMLButtonElement).disabled).toBe(true);
    release(jsonResponse({ success: true }));
    expect(await screen.findByText("You're in!")).toBeTruthy();
  });
});

describe('access-code unlock', () => {
  it('is not offered when the event has no hidden tiers', () => {
    renderPurchase();

    expect(screen.queryByLabelText('Have an access code?')).toBeNull();
  });

  it('reveals the unlocked tiers and merges them into the list', async () => {
    const fetchSpy = mockFetch({ '/tiers/unlock': jsonResponse({ tiers: [makeTierRow({ id: 'tier_vip', name: 'VIP', accessCode: 'VIP', price: 9000 })] }) });
    const { user } = renderPurchase({ hasHiddenTiers: true });

    await user.type(screen.getByLabelText('Have an access code?'), ' vip ');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('heading', { name: 'VIP' })).toBeTruthy();
    expect(screen.getByText('1 ticket type unlocked!')).toBeTruthy();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('code=vip');
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
  });

  it('reports an invalid code', async () => {
    mockFetch({ '/tiers/unlock': jsonResponse({ error: 'Invalid access code' }, 404) });
    const { user } = renderPurchase({ hasHiddenTiers: true });

    await user.type(screen.getByLabelText('Have an access code?'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid access code');
  });

  it('keeps Unlock disabled until a code is typed', () => {
    renderPurchase({ hasHiddenTiers: true });

    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
