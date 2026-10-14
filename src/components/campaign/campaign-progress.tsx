import { campaignMoney, type CampaignPledge, type CampaignStatus } from '@/hooks/campaign-api';

export function CampaignProgress({ status, pledge }: Readonly<{
  status: CampaignStatus;
  pledge: CampaignPledge | null;
}>) {
  const percent = Math.min(100, Math.max(0, status.percentFunded));
  return (
    <div className="space-y-3">
      <p>{campaignMoney(status.currentAmount)} of {campaignMoney(status.targetAmount)} CAD</p>
      <progress className="w-full" aria-label="Campaign funding" value={percent} max={100} />
      <p>{percent}% funded · {status.pledgeCount} backers</p>
      {status.isFullyFunded && <p>Goal reached!</p>}
      {status.deadline && <p>Campaign deadline: <time dateTime={status.deadline}>{new Date(status.deadline).toLocaleString()}</time></p>}
      {pledge && (
        <output className="block rounded-lg border p-3">
          <span className="block">Your pledge: {campaignMoney(pledge.amount)} CAD — {pledge.status}</span>
          {pledge.status === 'pending' && <span className="block">Not confirmed. Complete card setup to confirm your pledge.</span>}
          {pledge.status === 'confirmed' && <span className="block">Your card is saved. You will be charged when the goal is reached.</span>}
          {pledge.status === 'charged' && <span className="block">Your pledge has been charged.</span>}
        </output>
      )}
    </div>
  );
}
