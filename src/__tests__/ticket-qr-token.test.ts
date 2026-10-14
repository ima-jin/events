import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTicketQrToken, verifyTicketQrToken } from '@/lib/ticket-qr-token';
import { FAKE_QR, prepareTestVault } from './support/vault-fixture';
import { resetSelfSecretsForTests } from '@/lib/self-secrets';
vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: vi.fn(),
}));

const TICKET_ID = 'tkt_security';
const SECRET = FAKE_QR;
const NOW = 2_000_000_000;

beforeEach(async () => {
  await prepareTestVault();
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSelfSecretsForTests();
});

describe('ticket QR tokens', () => {
  it('accepts an authentic token, with or without a future expiry', () => {
    for (const expiry of [undefined, NOW + 60]) {
      expect(verifyTicketQrToken(createTicketQrToken(TICKET_ID, expiry), TICKET_ID)).toBe(true);
    }
  });

  it('binds the token to exactly one ticket', () => {
    expect(verifyTicketQrToken(createTicketQrToken(TICKET_ID), 'tkt_other')).toBe(false);
  });

  it('rejects tokens forged using another secret', async () => {
    const token = createTicketQrToken(TICKET_ID);
    await prepareTestVault('FAKE_ROTATED_QR_TEST_ONLY_'.repeat(4));
    expect(verifyTicketQrToken(token, TICKET_ID)).toBe(false);
  });

  it.each([NOW - 1, NOW, 1.5, Number.NaN])('rejects expired/invalid expiry %s', (expiry) => {
    expect(verifyTicketQrToken(createTicketQrToken(TICKET_ID, expiry), TICKET_ID)).toBe(false);
  });

  it.each([undefined, null, 42, TICKET_ID, 'ticket-v2.x.y', 'ticket-v1.x', 'x'.repeat(4097),
    'ticket-v1.x.short'])('rejects malformed or legacy token %s', (token) => {
    expect(verifyTicketQrToken(token, TICKET_ID)).toBe(false);
  });

  it('rejects payload tampering even when the signature length is correct', () => {
    const token = createTicketQrToken(TICKET_ID);
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ticketId: 'tkt_other' })).toString('base64url');
    expect(verifyTicketQrToken(parts.join('.'), TICKET_ID)).toBe(false);
  });

  it.each(['not JSON', 'null', '{}'])('rejects authenticated but malformed claims %s', (json) => {
    const payload = Buffer.from(json).toString('base64url');
    const signed = createHmac('sha256', SECRET).update(`ticket-v1.${payload}`).digest('base64url');
    expect(verifyTicketQrToken(`ticket-v1.${payload}.${signed}`, TICKET_ID)).toBe(false);
  });

  it('fails closed when the vault credentials are not loaded', () => {
    const token = createTicketQrToken(TICKET_ID);
    resetSelfSecretsForTests();
    expect(() => createTicketQrToken(TICKET_ID)).toThrow('TICKET_QR_SECRET');
    expect(() => verifyTicketQrToken(token, TICKET_ID)).toThrow('TICKET_QR_SECRET');
  });
});
