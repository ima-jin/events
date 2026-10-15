import { vi } from 'vitest';
import { loadFromVault } from '@ima-jin/auth-client';
import { loadSelfSecrets, resetSelfSecretsForTests } from '@/lib/self-secrets';


export const FAKE_SESSION = 'FAKE_SESSION_TEST_ONLY_'.repeat(4);
export const FAKE_QR = 'FAKE_QR_TEST_ONLY_'.repeat(4);

export async function prepareTestVault(qr = FAKE_QR): Promise<void> {
  resetSelfSecretsForTests();
  vi.mocked(loadFromVault).mockResolvedValue({
    values: { SESSION_SECRET: FAKE_SESSION, TICKET_QR_SECRET: qr },
    degraded: [],
  });
  await loadSelfSecrets('did:imajin:fixture');
}
