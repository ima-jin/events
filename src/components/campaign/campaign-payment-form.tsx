'use client';

import { useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { SetupIntent } from '@stripe/stripe-js';
import { campaignStripe, type CampaignSetup } from '@/hooks/campaign-stripe';

function CardSetup({ busy, onComplete }: Readonly<{
  busy: boolean;
  onComplete: (intent: SetupIntent) => Promise<void>;
}>) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!stripe || !elements || submitting || busy) return;
    setSubmitting(true);
    setError('');
    try {
      const submitted = await elements.submit();
      if (submitted.error) throw new Error('Invalid card');
      const returnUrl = new URL(globalThis.location.href);
      returnUrl.search = '';
      returnUrl.hash = '';
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: returnUrl.toString() },
        redirect: 'if_required',
      });
      if (result.error || !result.setupIntent) throw new Error('Card setup failed');
      await onComplete(result.setupIntent);
    } catch {
      setError('Card setup failed. Check your payment details and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <PaymentElement onReady={() => setReady(true)}
        onLoadError={() => setError('Could not load the secure card form. Please reload and try again.')} />
      {error && <p role="alert">{error}</p>}
      <button className="rounded-lg bg-orange-600 px-4 py-2 text-white disabled:opacity-50" type="submit"
        disabled={!stripe || !elements || !ready || submitting || busy}>
        {submitting || busy ? 'Confirming…' : 'Save card and confirm pledge'}
      </button>
    </form>
  );
}

export function CampaignPaymentForm({ setup, busy, onComplete }: Readonly<{
  setup: CampaignSetup;
  busy: boolean;
  onComplete: (intent: SetupIntent) => Promise<void>;
}>) {
  const stripe = useMemo(() => campaignStripe(), []);
  return (
    <Elements stripe={stripe} options={{ clientSecret: setup.clientSecret }}>
      <CardSetup busy={busy} onComplete={onComplete} />
    </Elements>
  );
}
