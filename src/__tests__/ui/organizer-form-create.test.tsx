// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { body, change, fillCreate, jsonResponse, mockFetch, push, renderForm } from '../support/organizer-form-support';

describe('organizer create form', () => {
  it('validates before sending, including dates and payment email', async () => {
    const fetch = mockFetch({});
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toContain('title is required');
    fillCreate();
    change('End date and time', '2099-12-01T17:00');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toContain('End must be after start');
    change('End date and time', '');
    await user.click(screen.getByLabelText('Accept e-Transfer payments'));
    change('Payment email', 'invalid');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toContain('valid payment email');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates event then updates access and creates tiers without retaining keys', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const fetch = mockFetch({
      '/api/events': (init) => {
        if (init?.method === 'POST' && body(init).eventType) return jsonResponse({ event: { id: 'evt_new', privateKey: 'NEVER_STORE' }, eventKeypair: { privateKey: 'NEVER_STORE' } }, 201);
        if (init?.method === 'POST') return jsonResponse({ tier: { id: 'tier_new' } }, 201);
        return jsonResponse({ event: { privateKey: 'NEVER_STORE' } });
      },
    });
    const { user, container } = renderForm();
    fillCreate();
    change('Tagline', 'A tagline');
    change('Description', 'Long description');
    change('Timezone (IANA)', 'America/Toronto');
    await user.selectOptions(screen.getByLabelText('Location type'), 'hybrid');
    change('Virtual URL', 'https://example.test/room');
    change('Venue', 'Hall');
    change('Linked course slug', 'course');
    await user.selectOptions(screen.getByLabelText('Access control'), 'invite_only');
    change('Price', '12.34');
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await user.click(screen.getByLabelText('Requires registration'));
    change('Registration form ID', 'form_1');
    change('Access code (optional)', ' STAFF ');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/e/evt_new'));
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/events/api/events', 'POST'], ['/events/api/events/evt_new', 'PUT'], ['/events/api/events/evt_new/tiers', 'POST'],
    ]);
    expect(body(fetch.mock.calls[0][1])).toMatchObject({ tickets: [], description: 'A tagline\n\nLong description', startsAt: '2099-12-01T23:00:00.000Z' });
    expect(body(fetch.mock.calls[2][1])).toMatchObject({ price: 1234, currency: 'USD', quantity: null, registrationFormId: 'form_1', accessCode: 'STAFF' });
    expect(container.textContent).not.toContain('NEVER_STORE');
    expect(fetch.mock.calls.every(([, init]) => !String(init?.body).includes('NEVER_STORE'))).toBe(true);
  });

  it('reorders stable tiers and removes only new tiers', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Add tier' }));
    const tier = screen.getByRole('group', { name: 'Ticket tier: New tier' });
    fireEvent.change(within(tier).getByLabelText('Tier name'), { target: { value: 'VIP' } });
    await user.click(within(tier).getByRole('button', { name: 'Move up' }));
    expect(screen.getAllByLabelText('Tier name').map((input) => (input as HTMLInputElement).value)).toEqual(['VIP', 'General Admission']);
    await user.click(screen.getAllByRole('button', { name: 'Remove new tier' })[0]);
    expect(screen.getAllByLabelText('Tier name')).toHaveLength(1);
  });

  it('uploads the expected multipart image and handles upload failure safely', async () => {
    const fetch = mockFetch({ '/api/upload': jsonResponse({ url: '/api/media/events/cover.png' }) });
    const { user } = renderForm();
    await user.upload(screen.getByLabelText('Upload cover image'), new File(['image'], 'cover.png', { type: 'image/png' }));
    await waitFor(() => expect((screen.getByLabelText('Cover image URL') as HTMLInputElement).value).toBe('/api/media/events/cover.png'));
    expect((fetch.mock.calls[0][1]?.body as FormData).get('image')).toBeInstanceOf(File);
    mockFetch({ '/api/upload': jsonResponse({ error: 'SECRET' }, 500) });
    await user.upload(screen.getByLabelText('Upload cover image'), new File(['x'], 'other.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Image upload failed'));
    expect(screen.queryByText('SECRET')).toBeNull();
  });

  it('blocks uncertain create retries and never renders server errors or keys', async () => {
    const fetch = mockFetch({ '/api/events': jsonResponse({ event: { privateKey: 'SECRET' } }, 201) });
    const { user } = renderForm();
    fillCreate();
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('uncertain'));
    expect((screen.getByRole('button', { name: 'Create event' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('SECRET')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains location values when switching physical, virtual and hybrid', async () => {
    const { user } = renderForm();
    change('Venue', 'Hall');
    await user.selectOptions(screen.getByLabelText('Location type'), 'virtual');
    expect(screen.queryByLabelText('Venue')).toBeNull();
    change('Virtual URL', 'https://example.test/room');
    await user.selectOptions(screen.getByLabelText('Location type'), 'hybrid');
    expect((screen.getByLabelText('Venue') as HTMLInputElement).value).toBe('Hall');
    expect((screen.getByLabelText('Virtual URL') as HTMLInputElement).value).toBe('https://example.test/room');
    await user.selectOptions(screen.getByLabelText('Location type'), 'physical');
    expect(screen.queryByLabelText('Virtual URL')).toBeNull();
  });

  it('requires a manual registration ID and rejects fractional prices', async () => {
    const fetch = mockFetch({});
    const { user } = renderForm();
    fillCreate();
    await user.click(screen.getByLabelText('Requires registration'));
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toContain('form ID is required');
    change('Registration form ID', 'form_1');
    change('Price', '1.234');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toContain('two decimal places');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized and unsupported uploads before fetching', () => {
    const fetch = mockFetch({});
    renderForm();
    const input = screen.getByLabelText('Upload cover image');
    fireEvent.change(input, { target: { files: [new File(['data'], 'file.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert').textContent).toContain('up to 10MB');
    const large = new File(['x'], 'large.png', { type: 'image/png' });
    Object.defineProperty(large, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [large] } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels create to the organizer dashboard', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(push).toHaveBeenCalledWith('/dashboard');
  });
});
