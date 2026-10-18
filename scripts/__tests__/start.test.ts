import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { vaultStart, claimStart, serverStart } = vi.hoisted(() => ({
  vaultStart: vi.fn(async (callback: () => Promise<void>) => callback()),
  claimStart: vi.fn(async (callback: () => Promise<void>) => callback()),
  serverStart: vi.fn(async () => {}),
}));
vi.mock('../../src/lib/vault-boot', () => ({
  startVaultServer: vaultStart, startClaimServer: claimStart,
}));
vi.mock('../server', () => ({ startServer: serverStart }));
const originalArguments = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = ['node', 'scripts/start.ts'];
  process.exitCode = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('runtime launcher', () => {
  it('starts the production server inside the vault boundary', async () => {
    await import('../start');
    await vi.waitFor(() => expect(serverStart).toHaveBeenCalledWith({ dev: false, claimOnly: false }));
    expect(vaultStart).toHaveBeenCalledOnce();
    expect(claimStart).not.toHaveBeenCalled();
  });

  it('starts the development server inside the same boundary', async () => {
    process.argv.push('--dev');
    await import('../start');
    await vi.waitFor(() => expect(serverStart).toHaveBeenCalledWith({ dev: true, claimOnly: false }));
    expect(vaultStart).toHaveBeenCalledOnce();
  });

  it('only selects isolated onboarding with an explicit flag', async () => {
    process.argv.push('--claim-only');
    await import('../start');
    await vi.waitFor(() => expect(serverStart).toHaveBeenCalledWith({ dev: false, claimOnly: true }));
    expect(claimStart).toHaveBeenCalledOnce();
    expect(vaultStart).not.toHaveBeenCalled();
  });

  it('exits 1 with one fixed line and no server import when required credentials fail', async () => {
    vaultStart.mockRejectedValueOnce(new Error('FAKE_PROVIDER_CONTENT_DO_NOT_DISCLOSE'));
    await import('../start');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(serverStart).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      'Events startup failed; verify the app keystore and /jin manifest sync, App secrets set/rotate and owner countersign. No server is ready.',
    );
  });
});
