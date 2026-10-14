'use client';

import { useEffect, useState } from 'react';
import { useCampaign } from '@/hooks/use-campaign';
import { useCampaignPayment } from '@/hooks/use-campaign-payment';
import { CampaignProgress } from './campaign-progress';
import { CampaignAmountForm } from './campaign-amount-form';
import { CampaignPaymentForm } from './campaign-payment-form';

export interface CampaignSectionProps {
  eventId: string;
  eventTitle: string;
  isAuthenticated: boolean;
  eventStatus?: string;
}

export function CampaignSection(props: Readonly<CampaignSectionProps>) {
  // A keyed boundary discards payment state if the event or authentication changes.
  return <CampaignContent key={`${props.eventId}:${props.isAuthenticated}`} {...props} />;
}

function CampaignContent({ eventId, eventTitle, isAuthenticated, eventStatus = 'published' }: Readonly<CampaignSectionProps>) {
  const campaign = useCampaign(eventId, isAuthenticated);
  const payment = useCampaignPayment(
    eventId, campaign.pledge, isAuthenticated && !campaign.loading && !campaign.error, campaign.confirmed,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const status = campaign.status;
  if (campaign.loading) return <output className="block">Loading campaign…</output>;
  if (campaign.error || !status) return (
    <div role="alert">{campaign.error || 'Campaign unavailable.'}
      <button type="button" onClick={() => void campaign.refresh()}>Retry campaign</button>
    </div>
  );
  const deadlinePassed = status.deadline !== null && new Date(status.deadline).getTime() <= now;
  const closed = eventStatus !== 'published' || deadlinePassed || status.isFullyFunded;
  const activePledge = campaign.pledge?.status === 'confirmed' || campaign.pledge?.status === 'charged';
  const canPledge = isAuthenticated && !closed && !activePledge;
  return (
    <section aria-label={`Campaign for ${eventTitle}`} className="mb-6 space-y-5 rounded-2xl bg-white p-6 shadow dark:bg-gray-800">
      <h2 className="text-2xl font-bold">Campaign</h2>
      <CampaignProgress status={status} pledge={campaign.pledge} />
      {closed && <p>Campaign closed for new pledges.</p>}
      {!isAuthenticated && !closed && <p>Sign in to pledge.</p>}
      {payment.error && <p role="alert">{payment.error}</p>}
      {payment.confirmation && (
        <button type="button" disabled={payment.busy} onClick={() => void payment.retry()}>Retry confirmation</button>
      )}
      {canPledge && !payment.confirmation && (
        payment.setup
          ? <CampaignPaymentForm setup={payment.setup} busy={payment.busy} onComplete={payment.complete} />
          : <CampaignAmountForm busy={payment.busy} onPledge={payment.create} />
      )}
    </section>
  );
}
