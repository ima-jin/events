'use client';

import type { FairSettlement } from '@/lib/buyer-tickets';

const ROLE_LABELS: Record<string, string> = {
  buyer_credit: 'Your credit', node: 'Node', platform: 'Protocol (MJN)', seller: 'Organizer', creator: 'Creator',
};

export function FairReceipt({ settlement }: Readonly<{ settlement: FairSettlement }>) {
  const format = (amount: number) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: settlement.currency || 'CAD',
  }).format(amount);
  const net = settlement.netAmount ?? settlement.chain.find((entry) => entry.role === 'seller')?.amount;
  return (
    <details className="mt-4 border-t border-gray-700 pt-4">
      <summary className="cursor-pointer text-sm text-orange-400">
        .fair settlement receipt {net !== undefined && `· Organizer receives ${format(net)}`}
      </summary>
      <dl className="mt-3 space-y-2 text-sm">
        {settlement.chain.map((entry) => (
          <div key={`${entry.role}-${entry.did}`} className="flex flex-wrap justify-between gap-2">
            <dt>{ROLE_LABELS[entry.role] ?? entry.role} <span className="break-all text-xs text-gray-400">{entry.did}</span></dt>
            <dd>{format(entry.amount)}</dd>
          </div>
        ))}
        {settlement.fees?.map((fee) => (
          <div key={`${fee.role}-${fee.name}`} className="flex justify-between gap-2 text-gray-400">
            <dt>{fee.name} ({(fee.rateBps / 100).toFixed(1)}%{fee.fixedCents > 0 && ` + ${format(fee.fixedCents / 100)}`})</dt>
            <dd>{fee.estimated && '~'}{format(fee.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between border-t border-gray-700 pt-2">
          <dt>Total paid</dt><dd>{format(settlement.totalAmount)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-gray-400">
        Settled {new Date(settlement.settledAt).toLocaleDateString('en-US')} · .fair v{settlement.version ?? '1.0'}
      </p>
    </details>
  );
}
