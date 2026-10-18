import { createLogger } from '@ima-jin/logger';
import { sendOrderOnboard } from '@/lib/kernel';
import { claimOrderOnboard } from '@/repositories/orders-repository';

const log = createLogger('events');

/** Request separate kernel-private mail once, never interrupting ordinary mail. */
export async function requestOrderOnboard(orderId: string | null): Promise<void> {
  if (!orderId) return;
  try {
    const transactionId = await claimOrderOnboard(orderId);
    if (transactionId) await sendOrderOnboard(transactionId);
  } catch {
    log.warn({ orderId }, 'Private onboarding unavailable (non-fatal)');
  }
}
