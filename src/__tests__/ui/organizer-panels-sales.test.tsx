// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SalesTab } from '@/components/organizer/sales-tab';
import { EVENT_ID, deferredResponse, jsonResponse, makeSale, mockFetch, renderPanel } from '../support/organizer-panels-support';

describe('organizer sales', () => {
  it('renders loading and empty states', async () => {
    const resolve = deferredResponse();
    renderPanel(<SalesTab eventId={EVENT_ID} />);
    expect(screen.getByRole('status').textContent).toContain('Loading sales');
    resolve(jsonResponse({ sales: [] }));
    expect(await screen.findByText(/No sales yet/)).toBeTruthy();
  });

  it('renders errors', async () => {
    mockFetch({ '/sales': jsonResponse({ error: 'Sales unavailable' }, 503) });
    renderPanel(<SalesTab eventId={EVENT_ID} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Sales unavailable');
  });

  it('formats minor units, keeps currencies separate, searches and filters', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    mockFetch({ '/sales': jsonResponse({ sales: [makeSale(), makeSale({ orderId: 'order_2', buyerName: 'Lin', currency: 'USD', amountTotal: 1000, status: 'pending' })] }) });
    const { user } = renderPanel(<SalesTab eventId={EVENT_ID} />);
    expect(await screen.findByText('CAD total: $25.00')).toBeTruthy();
    expect(screen.getByText('USD total: US$10.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export Sales CSV' }).getAttribute('href')).toBe('/events/api/events/evt_1/sales/export?format=csv');
    await user.selectOptions(screen.getByLabelText('Sale status'), 'pending');
    expect(screen.queryByText('Ada')).toBeNull();
    await user.type(screen.getByLabelText('Search sales'), 'no-match');
    expect(screen.getByText('No sales match your filters.')).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it('confirms held e-transfer orders only after confirmation', async () => {
    let paid = false;
    const spy = mockFetch({
      '/confirm-payment': () => { paid = true; return jsonResponse({ success: true }); },
      '/sales': () => jsonResponse({ sales: [makeSale({ status: paid ? 'completed' : 'pending', paymentMethod: 'etransfer' })] }),
    });
    const { user } = renderPanel(<SalesTab eventId={EVENT_ID} />);
    await user.click(await screen.findByRole('button', { name: 'Confirm e-Transfer' }));
    expect(paid).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Payment received' }));
    await within(await screen.findByRole('table')).findByText('completed');
    expect(spy.mock.calls.some(([path, init]) => path === '/api/orders/order_1/confirm-payment' && init?.method === 'POST')).toBe(true);
  });
});
