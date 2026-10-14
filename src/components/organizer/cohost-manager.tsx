'use client';

import { useState, type FormEvent } from 'react';
import { identityLabel, INPUT_CLASS, organizerPath, organizerRequest, PANEL_CLASS } from './organizer-data';
import { PanelState } from './panel-state';
import { useOrganizerData } from './use-organizer-data';
import { ConnectionPicker } from './connection-picker';

export interface OrganizerCohost {
  did: string;
  name: string | null;
  handle: string | null;
  role: string;
  addedAt: string;
}

export function CohostManager({ eventId, isCreator, creatorDid }: Readonly<{
  eventId: string;
  isCreator: boolean;
  creatorDid: string;
}>) {
  const path = organizerPath(eventId, '/cohosts');
  const state = useOrganizerData<{ cohosts: OrganizerCohost[] }>(path);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function mutate(method: 'POST' | 'DELETE', body: { did: string } | { handle: string }) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await organizerRequest<{ cohost: OrganizerCohost }>(path, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (method === 'POST') {
        state.setData((current) => ({
          cohosts: [...(current?.cohosts ?? []).filter((cohost) => cohost.did !== result.cohost.did), result.cohost],
        }));
        setTarget('');
        setSuccess('Co-host added.');
      } else {
        const removedDid = 'did' in body ? body.did : '';
        state.setData((current) => ({ cohosts: (current?.cohosts ?? []).filter((cohost) => cohost.did !== removedDid) }));
        setSuccess('Co-host removed.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update co-hosts.');
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = target.trim();
    if (!value) return;
    if (value === creatorDid) {
      setError('The event creator is already the owner.');
      return;
    }
    const body = value.startsWith('did:') ? { did: value } : { handle: value.replaceAll(/^@/g, '') };
    void mutate('POST', body);
  }

  return <section className={PANEL_CLASS} aria-label="Managers">
    <h2 className="mb-4 text-xl font-semibold">Co-hosts</h2>
    <p className="mb-3 text-sm">Creator: {creatorDid}</p>
    <PanelState {...state} label="co-hosts" />
    {state.data && <>
      {state.data.cohosts.length === 0 && <p>No co-hosts added yet.</p>}
      <ul className="my-4 space-y-3">{state.data.cohosts.map((cohost) => <li key={cohost.did} className="flex items-center justify-between gap-3">
        <div>{identityLabel(cohost.name, cohost.handle, null, cohost.did)} <span className="text-sm text-gray-500">Co-host</span></div>
        {isCreator && <button type="button" disabled={busy} onClick={() => void mutate('DELETE', { did: cohost.did })} aria-label={`Remove ${identityLabel(cohost.name, cohost.handle, null, cohost.did)}`}>Remove</button>}
      </li>)}</ul>
      {isCreator && <ConnectionPicker excludeDids={[creatorDid, ...state.data.cohosts.map((cohost) => cohost.did)]} disabled={busy} onSelect={(did) => void mutate('POST', { did })} />}
      {isCreator && <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <label>DID or handle <input className={INPUT_CLASS} value={target} onChange={(event) => setTarget(event.target.value)} disabled={busy} required /></label>
        <button type="submit" disabled={busy || target.trim().length === 0}>{busy ? 'Saving…' : 'Add co-host'}</button>
      </form>}
      {!isCreator && <p>Only the creator can manage co-hosts.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    {success && <p role="status">{success}</p>}
  </section>;
}
