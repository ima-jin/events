import type { Logger } from '@ima-jin/logger';
import {
  backfillContactEmail as backfillContactEmailViaKernel,
  getContactEmail as getContactEmailViaKernel,
} from '@/lib/kernel';

/**
 * Fetch the canonical contact_email for an identity DID via the kernel's
 * public API. Returns null if the identity doesn't exist, has no
 * contact_email, or the email isn't visible to this app. Never throws.
 */
export async function getContactEmail(
  did: string,
  log: Logger
): Promise<string | null> {
  try {
    return await getContactEmailViaKernel(did);
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to resolve contact_email');
    return null;
  }
}

/**
 * Backfill an identity's contact_email with a NULL guard — never overwrites.
 * Delegates to the kernel (`POST /auth/api/identity/:did/contact`); this app
 * never writes kernel tables. Never throws — a failed/unreachable kernel call
 * is logged as non-fatal.
 */
export async function backfillContactEmail(
  did: string,
  email: string,
  log: Logger
): Promise<void> {
  const ok = await backfillContactEmailViaKernel(did, email);
  if (!ok) {
    log.warn({ did }, 'Failed to backfill contact_email via kernel');
  }
}
