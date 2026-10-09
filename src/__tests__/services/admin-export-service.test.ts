import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminEventRow, csvLines } from '../support/sales-support';

const mocks = vi.hoisted(() => ({
  serviceUrl: vi.fn(),
  listAdminEventRows: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/kernel', () => ({ serviceUrl: mocks.serviceUrl }));
vi.mock('@/repositories/sales-repository', () => ({ listAdminEventRows: mocks.listAdminEventRows }));

import { buildAdminEventsCsv } from '@/services/admin-export-service';

function lookupResponse(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.serviceUrl.mockReturnValue('http://kernel.test/auth');
  mocks.listAdminEventRows.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllGlobals());

describe('buildAdminEventsCsv', () => {
  it('lists every event with ISO dates, flags, counts and the resolved creator handle', async () => {
    mocks.listAdminEventRows.mockResolvedValue([adminEventRow()]);
    mocks.fetch.mockResolvedValue(lookupResponse({ identity: { handle: 'creator-handle' } }));

    const file = await buildAdminEventsCsv();
    const [header, line] = csvLines(file.content);

    expect(mocks.fetch).toHaveBeenCalledWith('http://kernel.test/auth/api/lookup/did%3Aimajin%3Acreator', {
      cache: 'no-store',
    });
    expect(file.filename).toMatch(/^imajin-events-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(header.split(',')).toHaveLength(15);
    expect(line).toBe(
      'evt_1,Gala,published,2026-06-01T20:00:00.000Z,2026-06-01T23:00:00.000Z,Toronto,did:imajin:creator,creator-handle,2,10,4,50000,CAD,true,3',
    );
  });

  it('looks each distinct creator up once and accepts a flat lookup body', async () => {
    mocks.listAdminEventRows.mockResolvedValue([adminEventRow(), adminEventRow({ id: 'evt_2' })]);
    mocks.fetch.mockResolvedValue(lookupResponse({ handle: 'flat' }));

    const lines = csvLines((await buildAdminEventsCsv()).content);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(lines[2]).toContain(',did:imajin:creator,flat,');
  });

  it('treats a failed, rejected or handle-less lookup as no handle', async () => {
    mocks.listAdminEventRows.mockResolvedValue([
      adminEventRow({ creator_did: 'did:a' }),
      adminEventRow({ creator_did: 'did:b' }),
      adminEventRow({ creator_did: 'did:c' }),
    ]);
    mocks.fetch
      .mockResolvedValueOnce(lookupResponse({}, false))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(lookupResponse({ identity: {} }));

    const lines = csvLines((await buildAdminEventsCsv()).content);

    for (const line of lines.slice(1, 4)) expect(line).toMatch(/,did:[abc],,2,/);
  });

  it('blanks null columns, skips lookups without creators and tolerates a missing auth service url', async () => {
    mocks.serviceUrl.mockReturnValue(null);
    mocks.listAdminEventRows.mockResolvedValue([
      adminEventRow({
        starts_at: null,
        ends_at: null,
        city: null,
        creator_did: null,
        currency: null,
        has_registration_form: false,
      }),
    ]);

    const [, line] = csvLines((await buildAdminEventsCsv()).content);

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(line).toBe('evt_1,Gala,published,,,,,,2,10,4,50000,,false,3');
  });

  it('looks creators up against an empty base when the auth service url is unset', async () => {
    mocks.serviceUrl.mockReturnValue(null);
    mocks.listAdminEventRows.mockResolvedValue([adminEventRow()]);
    mocks.fetch.mockRejectedValue(new Error('invalid url'));

    await buildAdminEventsCsv();

    expect(mocks.fetch).toHaveBeenCalledWith('/api/lookup/did%3Aimajin%3Acreator', { cache: 'no-store' });
  });
});
