'use client';

import { useRef, useState } from 'react';
import { FairEditor } from '@ima-jin/fair/react';
import { withBasePath } from '@/lib/base-path';
import { editableManifest, type FairAttributionManifest } from './fair-manifest';

export interface FairAttributionProps {
  eventId: string;
  /** Explicit validated manifest only, not the surrounding event metadata or database row. */
  manifest?: FairAttributionManifest | null;
}

export function FairAttribution({ eventId, manifest }: Readonly<FairAttributionProps>) {
  const [initial] = useState(() => editableManifest(manifest));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function save() {
    if (locked.current || !draft) return;
    if (!editableManifest(draft)) {
      setError('Check the attribution shares and transfer settings before saving.');
      return;
    }
    locked.current = true;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const response = await fetch(withBasePath(`/api/events/${encodeURIComponent(eventId)}/fair`), {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: draft }),
      });
      if (!response.ok) throw new Error('Unable to save attribution');
      // The route returns a raw event row. Never parse, retain, display or log its body/keys.
      setSaved(true);
    } catch {
      setError('Unable to save attribution. Check your permissions and try again.');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }
  let saveLabel = 'Save attribution';
  if (saving) saveLabel = 'Saving attribution…';
  return (
    <section aria-labelledby="fair-attribution-heading" className="space-y-4 rounded-xl border border-gray-200 p-6 dark:border-gray-700">
      <h2 id="fair-attribution-heading" className="text-xl font-semibold">Attribution manifest</h2>
      <p className="text-sm text-gray-500">Every ticket records who created value and the agreed attribution.</p>
      {initial && draft ? (
        <>
          <fieldset disabled={saving}>
            <FairEditor manifest={draft} sections={['attribution', 'transfer']} readOnly={saving}
              onChange={(updated) => { setDraft(updated); setSaved(false); setError(''); }} />
          </fieldset>
          <button type="button" disabled={saving} onClick={() => { save(); }}
            className="rounded-lg bg-orange-500 px-6 py-3 font-semibold text-white disabled:opacity-50">{saveLabel}</button>
          {saved && <p role="status">Attribution saved.</p>}
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <p>No editable attribution manifest is attached. Older or fee-only formats are preserved unchanged; this editor does not migrate them.</p>
      )}
    </section>
  );
}
