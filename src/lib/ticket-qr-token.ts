import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSelfSecret } from './self-secrets';

const VERSION = 'ticket-v1';


function signature(payload: string): Buffer {
  return createHmac('sha256', getSelfSecret('TICKET_QR_SECRET')).update(`${VERSION}.${payload}`).digest();
}

/** Optional expiry is a Unix timestamp in seconds; omitted for long-lived emailed tickets. */
export function createTicketQrToken(ticketId: string, expiresAt?: number): string {
  const payload = Buffer.from(JSON.stringify({ ticketId, expiresAt })).toString('base64url');
  return `${VERSION}.${payload}.${signature(payload).toString('base64url')}`;
}

/** Fail closed for legacy IDs, tampering, wrong tickets, malformed payloads and expired tokens. */
export function verifyTicketQrToken(token: unknown, ticketId: string): boolean {
  if (typeof token !== 'string' || token.length > 4096) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const [, payload, suppliedSignature] = parts;
  const expected = signature(payload);
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims?.ticketId !== ticketId) return false;
    return claims.expiresAt === undefined ||
      (Number.isSafeInteger(claims.expiresAt) && claims.expiresAt > Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}
