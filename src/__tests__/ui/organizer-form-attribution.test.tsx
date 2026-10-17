// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '@ima-jin/fair';
import { editableManifest } from '@/components/organizer-form/fair-manifest';
import { body, jsonResponse, manifestFixture, mockFetch, renderAttribution } from '../support/organizer-ui-support';
import { documentManifestFixture, feeManifestFixture } from '../support/editable-fair-fixtures';

describe('organizer attribution', () => {
  it('renders only published attribution and transfer sections', () => {
    renderAttribution();
    expect(screen.getByText('Attribution')).toBeTruthy();
    expect(screen.getByText('Transfer')).toBeTruthy();
    expect(screen.getByLabelText('Transfers allowed')).toBeTruthy();
    expect(screen.queryByText('Revenue Chain')).toBeNull();
    expect(screen.queryByText('Access')).toBeNull();
  });

  it('PATCHes the edited manifest with base path and ignores the returned raw event body', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const response = jsonResponse({ event: { privateKey: 'NEVER_READ' } });
    const json = vi.spyOn(response, 'json');
    const fetch = mockFetch({ '/api/events/evt_edit/fair': () => response });
    const { user, container } = renderAttribution();
    await user.click(screen.getByLabelText('Refundable'));
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Attribution saved.'));
    expect(fetch.mock.calls[0][0]).toBe('/events/api/events/evt_edit/fair');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PATCH', credentials: 'include' });
    expect(body(fetch.mock.calls[0][1])).toMatchObject({ manifest: { transfer: { refundable: true } } });
    expect(json).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('NEVER_READ');
    await user.click(screen.getByLabelText('Refundable'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses generic errors and allows retry without parsing failure bodies', async () => {
    const response = jsonResponse({ error: 'NEVER_READ' }, 403);
    const json = vi.spyOn(response, 'json');
    mockFetch({ '/api/events': () => response });
    const { user } = renderAttribution();
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to save attribution'));
    expect(json).not.toHaveBeenCalled();
    expect(screen.queryByText('NEVER_READ')).toBeNull();
    mockFetch({ '/api/events': jsonResponse({}) });
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });

  it('validates invalid editor shares before sending', async () => {
    const fetch = mockFetch({});
    const { user } = renderAttribution();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '110' } });
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    expect(screen.getByRole('alert').textContent).toContain('Check the attribution shares');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, { version: 'unsupported' }, { ...manifestFixture(), attribution: [null] }])(
    'shows a safe fallback only for absent, malformed or unsupported manifests: %j', (manifest) => {
      renderAttribution({ manifest: editableManifest(manifest) });
      expect(screen.getByText(/No supported attribution manifest/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Save attribution' })).toBeNull();
    },
  );

  it.each([
    ['fee 0.4.0', feeManifestFixture()],
    ['tax-bearing fee 0.5.0', feeManifestFixture(true)],
    ['document 1.0', documentManifestFixture('1.0')],
    ['document 1.1', documentManifestFixture('1.1')],
  ] as const)('edits, saves and reloads %s without conversion or data loss', async (_shape, original) => {
    let stored: unknown = JSON.parse(JSON.stringify(original));
    const fetch = mockFetch({ '/api/events/evt_edit/fair': (init) => {
      stored = body(init).manifest;
      expect(validateManifest(stored).valid).toBe(true);
      return jsonResponse({});
    } });
    const { user, unmount } = renderAttribution({ manifest: editableManifest(stored) });
    expect(screen.queryByText(/No supported attribution manifest/)).toBeNull();
    const note = screen.getByPlaceholderText('Note (optional)');
    await user.clear(note);
    await user.type(note, 'Updated event credit');
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    const expected = {
      ...original,
      attribution: [{ ...original.attribution[0], note: 'Updated event credit' }],
    };
    expect(stored).toEqual(expected);
    expect(original.attribution[0].note).toBe('Original credit');
    unmount();
    const reloaded = renderAttribution({ manifest: editableManifest(JSON.parse(JSON.stringify(stored))) });
    expect((screen.getByPlaceholderText('Note (optional)') as HTMLInputElement).value).toBe('Updated event credit');
    await reloaded.user.click(screen.getByRole('button', { name: 'Save attribution' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(stored).toEqual(expected);
  });

  it('rejects fee attribution shares that no longer sum to one', async () => {
    const fetch = mockFetch({});
    const { user } = renderAttribution({ manifest: feeManifestFixture() });
    expect(screen.queryByText('Transfer')).toBeNull();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '90' } });
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    expect(screen.getByRole('alert').textContent).toContain('Check the attribution shares');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables duplicate save and editor input during PATCH', async () => {
    let complete: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    const fetch = mockFetch({ '/api/events': () => pending });
    const { user } = renderAttribution();
    await user.click(screen.getByRole('button', { name: 'Save attribution' }));
    const saving = screen.getByRole('button', { name: 'Saving attribution…' }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    await user.click(saving);
    expect(fetch).toHaveBeenCalledTimes(1);
    complete(jsonResponse({}));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
});
