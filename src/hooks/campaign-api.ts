import { withBasePath } from '@/lib/base-path';

export interface CampaignStatus {
  targetAmount: number;
  currentAmount: number;
  pledgeCount: number;
  deadline: string | null;
  percentFunded: number;
  isFullyFunded: boolean;
}

export interface CampaignPledge {
  id: string;
  amount: number;
  status: string;
}

export async function campaignRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(withBasePath(path), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
  if (!response.ok) throw new Error('Campaign request failed. Please try again.');
  return response.json() as Promise<T>;
}

export function campaignMoney(amount: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount / 100);
}
