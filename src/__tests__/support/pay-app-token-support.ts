import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPayAppToken: vi.fn(),
  invalidatePayAppToken: vi.fn(),
}));

export const APP_TOKEN = 'events-app-token';
export const getPayAppTokenMock = mocks.getPayAppToken;
export const invalidatePayAppTokenMock = mocks.invalidatePayAppToken;

vi.mock('@/lib/pay-app-token', () => mocks);

export function resetPayAppTokenMocks(): void {
  getPayAppTokenMock.mockReset().mockResolvedValue(APP_TOKEN);
  invalidatePayAppTokenMock.mockReset().mockResolvedValue(undefined);
}
