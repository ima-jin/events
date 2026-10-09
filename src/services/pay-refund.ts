import { serviceUrl } from '@/lib/kernel';

export type PayRefundResult = { ok: true } | { ok: false; status: number; text: string };

/**
 * Ask the kernel pay service to refund a payment (`POST {pay}/api/refund`).
 * Omit `amount` for a full refund.
 *
 * NOTE: authentication is still the shared `PAY_SERVICE_API_KEY` bearer
 * (kernel parity — migration to an app token is tracked in imajin-ai#2739).
 */
export async function requestPayRefund(body: {
  paymentId: string;
  amount?: number;
  reason?: string;
}): Promise<PayRefundResult> {
  const response = await fetch(`${serviceUrl('pay') ?? ''}/api/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PAY_SERVICE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return { ok: true };
  }
  return { ok: false, status: response.status, text: await response.text() };
}
