import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Logger } from '@ima-jin/logger';

// Configure ed25519 with sha512
ed.hashes.sha512 = sha512;

/** What a ticket signature is bound to: the event identity and its (optional) signing key. */
export interface TicketSigningContext {
  eventId: string;
  eventDid?: string;
  /** Hex-encoded Ed25519 private key of the event; absent events get a base64 fallback signature. */
  eventPrivateKey?: string | null;
  log?: Logger;
}

/**
 * Sign a ticket with the event's Ed25519 private key, falling back to a
 * base64-encoded signature payload when the event has no private key.
 */
export async function signTicketPayload(
  ticketId: string,
  customerEmail: string,
  context: TicketSigningContext,
): Promise<string> {
  const { eventId, eventDid, eventPrivateKey, log } = context;
  const signatureData = `${ticketId}:${eventDid}:${customerEmail}:${Date.now()}`;

  if (eventPrivateKey) {
    const msgBytes = new TextEncoder().encode(signatureData);
    const sigBytes = await ed.signAsync(msgBytes, hexToBytes(eventPrivateKey));
    return bytesToHex(sigBytes);
  }

  log?.warn?.({ eventId }, 'Event has no privateKey — using base64 fallback signature');
  return Buffer.from(signatureData).toString('base64');
}

/**
 * Compute the signature for a newly-created ticket, or null when the ticket
 * isn't valid yet (e.g. held e-Transfer tickets) or has no customer email to
 * bind the signature to.
 */
export async function resolveTicketSignature(
  ticketId: string,
  ticketStatus: 'valid' | 'held',
  customerEmail: string | undefined,
  context: TicketSigningContext,
): Promise<string | null> {
  if (ticketStatus !== 'valid' || !customerEmail) {
    return null;
  }
  return signTicketPayload(ticketId, customerEmail, context);
}
