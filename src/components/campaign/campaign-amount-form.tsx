'use client';

import { useState } from 'react';

const PRESETS = [10, 25, 50, 100, 250];

export function CampaignAmountForm({ busy, onPledge }: Readonly<{
  busy: boolean;
  onPledge: (amount: number) => Promise<void>;
}>) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const cents = Number(amount) * 100;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || !Number.isSafeInteger(Math.round(cents))
      || Math.abs(cents - Math.round(cents)) > 0.00001 || cents < 100) {
      setError('Enter a valid pledge of at least $1.00 with at most two decimal places.');
      return;
    }
    setError('');
    await onPledge(Math.round(cents));
  }

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p>You will not be charged until the campaign reaches its goal.</p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button className="rounded-lg border px-4 py-2" type="button" key={preset}
            disabled={busy} aria-pressed={amount === String(preset)} onClick={() => setAmount(String(preset))}>
            ${preset}
          </button>
        ))}
      </div>
      <label className="block">
        Pledge amount (CAD)
        <input className="ml-2 rounded border p-2 text-black" inputMode="decimal" value={amount}
          disabled={busy} onChange={(event) => setAmount(event.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="rounded-lg bg-orange-600 px-4 py-2 text-white disabled:opacity-50"
        type="submit" disabled={busy}>{busy ? 'Starting card setup…' : 'Continue to card setup'}</button>
    </form>
  );
}
