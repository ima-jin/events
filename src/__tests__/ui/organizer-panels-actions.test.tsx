// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GuestActions } from '@/components/organizer/guest-actions';
import { EVENT_ID, jsonResponse, makeGuest, mockFetch, renderPanel } from '../support/organizer-ui-support';

describe('organizer guest actions', () => {
  it('allows co-host check-in and resend but hides refund/cancel', async () => {
    const spy = mockFetch({ '/tickets': jsonResponse({ ticket: { usedAt: '2026-10-14' } }) });
    const changed = vi.fn();
    const { user } = renderPanel(<GuestActions eventId={EVENT_ID} guest={makeGuest()} isCreator={false} onChanged={changed} />);
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(spy.mock.calls[0][0]).toBe('/api/events/evt_1/tickets/ticket_1/check-in');
    await user.click(screen.getByRole('button', { name: 'Resend Email' }));
    expect(spy.mock.calls[1][0]).toContain('/resend-email');
  });

  it('confirms creator cancellation of held tickets', async () => {
    const spy = mockFetch({ '/cancel': jsonResponse({ success: true }) });
    const { user } = renderPanel(<GuestActions eventId={EVENT_ID} guest={makeGuest({ status: 'held' })} isCreator onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Cancel Ticket' }));
    expect(spy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm action' }));
    expect(spy.mock.calls[0][0]).toContain('/cancel');
  });

  it('explains manual refunds and requires confirmation before marking sent', async () => {
    const changed = vi.fn();
    const spy = mockFetch({
      '/mark-refund-sent': jsonResponse({ success: true }),
      '/refund': jsonResponse({ manualRefundRequired: true, refundEmail: 'buyer@example.test', refundAmount: '25.00', refundCurrency: 'CAD' }),
    });
    const { user } = renderPanel(<GuestActions eventId={EVENT_ID} guest={makeGuest({ paymentMethod: 'etransfer' })} isCreator onChanged={changed} />);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await user.click(screen.getByRole('button', { name: 'Confirm action' }));
    expect(await screen.findByText(/Manual refund required: send 25.00 CAD/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Mark Refund Sent' }));
    await user.click(screen.getByRole('button', { name: 'Confirm action' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(spy.mock.calls[1][0]).toContain('/mark-refund-sent');
  });

  it('shows server action errors', async () => {
    mockFetch({ '/tickets': jsonResponse({ error: 'Email recently sent' }, 429) });
    const { user } = renderPanel(<GuestActions eventId={EVENT_ID} guest={makeGuest()} isCreator onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Resend Email' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Email recently sent');
  });
  it('does not resend on cooldown', () => {
    renderPanel(<GuestActions eventId={EVENT_ID} guest={makeGuest({ lastEmailSentAt: new Date().toISOString() })} isCreator={false} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Resend Email' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check In' })).toBeTruthy();
  });
});
