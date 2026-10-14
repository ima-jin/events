import { payForbiddenMessage, postPayAsApp } from '@/lib/pay-app-request';

export type PayRefundResult = { ok: true } | { ok: false; status: number; text: string };

/**
 * Ask the kernel pay service to refund a payment (`POST {pay}/api/refund`).
 * Omit `amount` for a full refund.
 *
 * Uses events' own app-service token with operator-approved `pay:refund`.
 * The kernel checks payment ownership and enforces refund replay safety.
 */
export async function requestPayRefund(body: {
  paymentId: string;
  amount?: number;
  reason?: string;
}): Promise<PayRefundResult> {
  const response = await postPayAsApp('/api/refund', body);

  if (response.ok) {
    return { ok: true };
  }
  const text = await response.text();
  return {
    ok: false,
    status: response.status,
    text: response.status === 403 ? `${payForbiddenMessage('pay:refund')}. ${text}` : text,
  };
}
