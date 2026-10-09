/**
 * Tests for app/api/admin/events/export.csv/route.ts (thin handler over admin-export-service).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  buildAdminEventsCsv: vi.fn(),
  log: { error: vi.fn() },
}));

vi.mock('@ima-jin/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/services/admin-export-service', () => ({ buildAdminEventsCsv: mocks.buildAdminEventsCsv }));

import { GET } from '../../app/api/admin/events/export.csv/route';

const request = () => new NextRequest('https://events.test/api/admin/events/export.csv');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ identity: { id: 'did:imajin:admin', scopes: [], via: 'token' } });
});

describe('GET /api/admin/events/export.csv', () => {
  it('returns the service CSV as an attachment', async () => {
    mocks.buildAdminEventsCsv.mockResolvedValue({
      filename: 'imajin-events-2026-01-01.csv',
      contentType: 'text/csv; charset=utf-8',
      content: '\uFEFFEvent ID\r\n',
    });

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="imajin-events-2026-01-01.csv"');
    // Response.text() drops the BOM; the raw bytes must still start with it (EF BB BF).
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('passes an admin-auth failure through without exporting', async () => {
    mocks.requireAdmin.mockResolvedValue({ error: 'Admin access required', status: 403 });

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
    expect(mocks.buildAdminEventsCsv).not.toHaveBeenCalled();
  });

  it('logs and answers 500 when the export fails', async () => {
    mocks.buildAdminEventsCsv.mockRejectedValue(new Error('boom'));

    const res = await GET(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to export events' });
    expect(mocks.log.error).toHaveBeenCalled();
  });
});
