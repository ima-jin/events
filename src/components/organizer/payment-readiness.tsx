import type { CardRailReadiness } from '@/lib/card-rail';

export function PaymentReadiness({ readiness, hasPaidTiers, emtEnabled, published = false }: Readonly<{
  readiness?: CardRailReadiness;
  hasPaidTiers: boolean;
  emtEnabled: boolean;
  published?: boolean;
}>) {
  if (!readiness || readiness.cardEnabled === true) return null;
  const needsRail = hasPaidTiers && !emtEnabled;
  let message = 'Free tickets are unaffected. You can also accept e-Transfer with a payment email.';
  if (needsRail) message = 'Paid tickets need card payments or e-Transfer before publishing.';
  if (hasPaidTiers && emtEnabled) message = 'e-Transfer is available. Buyers will not see a card button until card payments are set up.';
  if (readiness.cardEnabled === null) message = 'Card payment readiness is unavailable. Retry saving or publishing, or refresh this page to check again. Free tickets and e-Transfer remain available.';
  return <aside className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950" aria-label="Payment readiness">
    {published && needsRail && <p>Your published paid event has no confirmed payment rail. It remains published; set up payments before making paid-ticket changes.</p>}
    <p>{message}</p>
    {readiness.setupUrl && <a className="underline" href={readiness.setupUrl}>Set up card payments</a>}
  </aside>;
}
