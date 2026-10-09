'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { BuyerDetails } from './checkout-api';
import { BUTTON_GHOST, BUTTON_PRIMARY_INLINE, ERROR_TEXT, INPUT, MUTED, PANEL } from './styles';

interface BuyerFormProps {
  title: string;
  children?: ReactNode;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  /** Ask for name + email (anonymous buyers, or a signed-in buyer whose account has no email). */
  collectDetails: boolean;
  onSubmit: (buyer: BuyerDetails) => void;
  onCancel: () => void;
}

/** Shared confirm step for free RSVPs and e-Transfer reservations. */
export function BuyerForm({ title, children, submitLabel, busyLabel, busy, error, collectDetails, onSubmit, onCancel }: Readonly<BuyerFormProps>) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const invalid = collectDetails && !email.includes('@');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid) return;
    onSubmit(collectDetails ? { name, email } : {});
  };

  return (
    <form onSubmit={handleSubmit} className={PANEL} aria-label={title}>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <div className={MUTED}>{children}</div>}
      {collectDetails && (
        <div className="space-y-2">
          <label className="block text-sm">
            Your name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} className={`${INPUT} mt-1`} />
          </label>
          <label className="block text-sm">
            Your email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} required className={`${INPUT} mt-1`} />
          </label>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || invalid} className={`${BUTTON_PRIMARY_INLINE} whitespace-nowrap`}>
          {busy ? busyLabel : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={BUTTON_GHOST}>
          Back
        </button>
      </div>
      {error && <p role="alert" className={ERROR_TEXT}>{error}</p>}
    </form>
  );
}
