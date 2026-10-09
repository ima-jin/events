'use client';

import { useState, type FormEvent } from 'react';
import type { PublicTier } from '@/lib/public-event';
import { unlockTiers } from './checkout-api';
import { BUTTON_PRIMARY_INLINE, ERROR_TEXT, INPUT, MUTED } from './styles';

interface UnlockFormProps {
  eventId: string;
  onUnlocked: (tiers: PublicTier[]) => void;
}

/** Reveals hidden (access-code) ticket tiers via `/api/events/{id}/tiers/unlock`. */
export function UnlockForm({ eventId, onUnlocked }: Readonly<UnlockFormProps>) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const tiers = await unlockTiers(eventId, trimmed);
      onUnlocked(tiers);
      setNotice(`${tiers.length} ticket type${tiers.length === 1 ? '' : 's'} unlocked!`);
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border-t border-gray-700 pt-4">
      <label htmlFor="tier-access-code" className={MUTED}>
        Have an access code?
      </label>
      <div className="flex gap-2">
        <input
          id="tier-access-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          placeholder="Enter code"
          autoComplete="off"
          className={INPUT}
        />
        <button type="submit" disabled={busy || !code.trim()} className={BUTTON_PRIMARY_INLINE}>
          {busy ? '…' : 'Unlock'}
        </button>
      </div>
      {error && <p role="alert" className={ERROR_TEXT}>{error}</p>}
      {notice && <output className="block text-xs text-green-500">{notice}</output>}
    </form>
  );
}
