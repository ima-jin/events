'use client';

import { useState } from 'react';
import { withBasePath } from '@/lib/base-path';
import { identityLabel, INPUT_CLASS } from './organizer-data';
import { PanelState } from './panel-state';
import { useOrganizerData } from './use-organizer-data';

export interface OrganizerConnection {
  did: string;
  handle: string | null;
  name: string | null;
  nickname: string | null;
  connectedAt: string;
}

export function ConnectionPicker({ excludeDids, disabled, onSelect }: Readonly<{
  excludeDids: readonly string[];
  disabled: boolean;
  onSelect: (did: string) => void;
}>) {
  const state = useOrganizerData<{ connections: OrganizerConnection[] }>(withBasePath('/api/proxy/connections'));
  const [search, setSearch] = useState('');
  const results = (state.data?.connections ?? []).filter((connection) =>
    !excludeDids.includes(connection.did) && [connection.name, connection.nickname, connection.handle, connection.did]
      .some((value) => value?.toLowerCase().includes(search.toLowerCase())),
  );
  return <div className="mb-4">
    <label>Search connections <input className={INPUT_CLASS} type="search" value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} /></label>
    <PanelState {...state} label="connections" />
    {state.data && search && <>
      {results.length === 0 && <p>No connections match. You can enter a DID or handle below.</p>}
      <ul className="mt-2 space-y-2">{results.map((connection) => <li key={connection.did}>
        <button type="button" disabled={disabled} onClick={() => onSelect(connection.did)}>
          Add {identityLabel(connection.nickname || connection.name, connection.handle, null, connection.did)}
        </button>
      </li>)}</ul>
    </>}
  </div>;
}
