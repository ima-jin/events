'use client';

import type { ReactNode } from 'react';
import { formatDeadline, formatPrice } from '@/lib/public-event';
import type { EtransferInstructions, FinishedCheckout } from './checkout-api';
import { MUTED, PANEL } from './styles';

function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex items-center justify-between border-b border-gray-700 py-2 last:border-b-0">
      <dt className="text-gray-400">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function EtransferReserved({ instructions }: Readonly<{ instructions: EtransferInstructions }>) {
  return (
    <section className={PANEL} aria-label="e-Transfer instructions">
      <h3 className="text-base font-semibold">Reserved — send your e-Transfer to confirm</h3>
      <p className="text-xs text-orange-500">
        You don&apos;t have your ticket yet. It&apos;ll be activated once we confirm your payment.
      </p>
      <dl className="text-sm">
        <Row label="Amount">{formatPrice(instructions.amount, instructions.currency)}</Row>
        <Row label="Send your e-Transfer to"><span className="font-mono">{instructions.email}</span></Row>
        <Row label="Required memo"><span className="font-mono font-semibold text-orange-500">{instructions.memo}</span></Row>
        <Row label="Pay by">{formatDeadline(instructions.deadline)}</Row>
      </dl>
      <p className="rounded-lg bg-gray-800 p-3 text-xs text-gray-400">{instructions.message}</p>
      {instructions.orderId && (
        <p className="text-xs text-gray-400">
          Order ID: <span className="font-mono">{instructions.orderId}</span>
        </p>
      )}
    </section>
  );
}

function Confirmation({ title, children }: Readonly<{ title: string; children?: ReactNode }>) {
  return (
    <output className={`block ${PANEL}`}>
      <h3 className="text-base font-semibold text-green-500">{title}</h3>
      {children && <p className={MUTED}>{children}</p>}
    </output>
  );
}

/** What the buyer sees once a non-redirect checkout rail has succeeded. */
export function ResultView({ result }: Readonly<{ result: FinishedCheckout }>) {
  if (result.kind === 'etransfer') return <EtransferReserved instructions={result.instructions} />;
  if (result.kind === 'verification') return <Confirmation title="Check your email">{result.message}</Confirmation>;
  if (result.kind === 'balance') {
    return <Confirmation title="Payment complete">Your tickets are confirmed. Order ID: {result.orderId}</Confirmation>;
  }
  return <Confirmation title="You're in!" />;
}
