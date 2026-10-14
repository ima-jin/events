// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CohostManager } from '@/components/organizer/cohost-manager';
import { CREATOR_DID, EVENT_ID, deferredResponse, jsonResponse, makeCohost, mockFetch, renderPanel } from '../support/organizer-ui-support';

function manager(isCreator = true) {
  return <CohostManager eventId={EVENT_ID} creatorDid={CREATOR_DID} isCreator={isCreator} />;
}

describe('organizer managers', () => {
  it('shows loading and empty states', async () => {
    const resolve = deferredResponse();
    renderPanel(manager());
    expect(screen.getByRole('status').textContent).toContain('Loading co-hosts');
    resolve(jsonResponse({ cohosts: [] }));
    expect(await screen.findByText('No co-hosts added yet.')).toBeTruthy();
  });

  it('reports read errors', async () => {
    mockFetch({ '/cohosts': jsonResponse({ error: 'Cannot load co-hosts' }, 502) });
    renderPanel(manager());
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot load co-hosts');
    expect(screen.queryByRole('button', { name: 'Add co-host' })).toBeNull();
  });

  it('adds handles and removes by DID using the same URL', async () => {
    const spy = mockFetch({ '/cohosts': (init) => {
      if (init?.method === 'POST') return jsonResponse({ cohost: makeCohost() }, 201);
      return jsonResponse({ cohosts: [] });
    } });
    const { user } = renderPanel(manager());
    await screen.findByText('No co-hosts added yet.');
    await user.type(screen.getByLabelText('DID or handle'), '@lin');
    await user.click(screen.getByRole('button', { name: 'Add co-host' }));
    expect(await screen.findByText('Lin')).toBeTruthy();
    const add = spy.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(add?.[1]?.body))).toEqual({ handle: 'lin' });
    await user.click(screen.getByRole('button', { name: 'Remove Lin' }));
    await waitFor(() => expect(screen.queryByText('Lin')).toBeNull());
    const remove = spy.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(remove?.[0]).toBe(add?.[0]);
    expect(JSON.parse(String(remove?.[1]?.body))).toEqual({ did: 'did:imajin:cohost' });
  });

  it('adds DID values and reports mutation errors without losing the list', async () => {
    const spy = mockFetch({ '/cohosts': (init) => {
      if (init?.method === 'POST') return jsonResponse({ error: 'Identity not found' }, 404);
      if (init?.method === 'DELETE') return jsonResponse({ error: 'Removal failed' }, 502);
      return jsonResponse({ cohosts: [makeCohost()] });
    } });
    const { user } = renderPanel(manager());
    await screen.findByText('Lin');
    await user.type(screen.getByLabelText('DID or handle'), 'did:imajin:missing');
    await user.click(screen.getByRole('button', { name: 'Add co-host' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Identity not found');
    expect(JSON.parse(String(spy.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ did: 'did:imajin:missing' });
    await user.click(screen.getByRole('button', { name: 'Remove Lin' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Removal failed'));
    expect(screen.getByText('Lin')).toBeTruthy();
  });

  it('renders co-host viewers read only', async () => {
    mockFetch({ '/cohosts': jsonResponse({ cohosts: [makeCohost({ name: null, handle: null })] }) });
    renderPanel(manager(false));
    expect(await screen.findByText('did:imajin:cohost')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });
  it('selects a connection by DID and excludes the creator and current co-hosts', async () => {
    const spy = mockFetch({
      '/api/proxy/connections': jsonResponse({ connections: [
        { did: CREATOR_DID, name: 'Connection Creator', handle: 'creator', nickname: null, connectedAt: '2026-10-14' },
        { did: 'did:imajin:cohost', name: 'Connection Existing', handle: 'lin', nickname: null, connectedAt: '2026-10-14' },
        { did: 'did:imajin:new', name: 'Connection New', handle: 'new', nickname: null, connectedAt: '2026-10-14' },
      ] }),
      '/cohosts': (init) => init?.method === 'POST'
        ? jsonResponse({ cohost: makeCohost({ did: 'did:imajin:new', name: 'Connection New' }) })
        : jsonResponse({ cohosts: [makeCohost()] }),
    });
    const { user } = renderPanel(manager());
    await screen.findByText('Lin');
    await user.type(screen.getByLabelText('Search connections'), 'Connection');
    expect(await screen.findByRole('button', { name: 'Add Connection New' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Connection Creator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Connection Existing' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Connection New' }));
    expect(await screen.findByText('Connection New')).toBeTruthy();
    expect(JSON.parse(String(spy.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ did: 'did:imajin:new' });
    expect(screen.queryByRole('button', { name: 'Add Connection New' })).toBeNull();
  });
});
