import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateQRCode } from '@/lib/email';
import { verifyTicketQrToken } from '@/lib/ticket-qr-token';
import { prepareTestVault } from './support/vault-fixture';
import { resetSelfSecretsForTests } from '@/lib/self-secrets';
vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: vi.fn(),
}));

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn<(token: string) => Promise<string>>(),
}));
vi.mock('qrcode', () => ({ default: { toDataURL } }));
vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

beforeEach(async () => {
  await prepareTestVault();
  toDataURL.mockReset();
});
afterEach(() => resetSelfSecretsForTests());

describe('shared ticket QR generation', () => {
  it('encodes signed tokens for both the API and every email issuance path', async () => {
    toDataURL.mockResolvedValue('data:image/png;base64,signed');
    expect(await generateQRCode('tkt_email')).toBe('data:image/png;base64,signed');
    const token = toDataURL.mock.calls[0][0];
    expect(token).not.toBe('tkt_email');
    expect(verifyTicketQrToken(token, 'tkt_email')).toBe(true);
  });

  it('returns no QR when rendering fails', async () => {
    toDataURL.mockRejectedValue(new Error('render failed'));
    expect(await generateQRCode('tkt_email')).toBe('');
  });

  it('never falls back to a raw ID when signing is unavailable', async () => {
    resetSelfSecretsForTests();
    expect(await generateQRCode('tkt_email')).toBe('');
    expect(toDataURL).not.toHaveBeenCalled();
  });
});
