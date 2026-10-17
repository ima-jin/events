import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { PATCH } from '../../app/api/events/[id]/fair/route';
import { editableManifest } from '@/components/organizer-form/fair-manifest';
import { createDrizzleChain, makeEventRow } from './support/events-support';
import { documentManifestFixture, feeManifestFixture } from './support/editable-fair-fixtures';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), organizer: vi.fn(), select: vi.fn(), update: vi.fn(),
}));
vi.mock('@/lib/route-guards', () => ({ requireActor: mocks.actor }));
vi.mock('@/lib/organizer', () => ({ isEventOrganizer: mocks.organizer }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db', async () => ({
  ...await import('@/db/schema'), db: { select: mocks.select, update: mocks.update },
}));

const context = { params: Promise.resolve({ id: 'evt_edit' }) };
function request(manifest: unknown) {
  return new NextRequest('https://events.test/api/events/evt_edit/fair', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ did: 'did:imajin:creator' });
  mocks.organizer.mockResolvedValue({ authorized: true, role: 'creator' });
});

describe('PATCH event attribution with the published validator', () => {
  it.each([
    ['fee 0.4.0', feeManifestFixture()],
    ['fee 0.5.0 with taxes', feeManifestFixture(true)],
    ['document 1.0', documentManifestFixture('1.0')],
    ['document 1.1', documentManifestFixture('1.1')],
  ] as const)('persists and reloads %s unchanged alongside unrelated event metadata', async (_shape, manifest) => {
    const metadata = { campaign: { goal: 5000 }, linkedSurveys: ['survey_1'], fair: manifest };
    let stored = makeEventRow({ id: 'evt_edit', metadata });
    mocks.select.mockImplementation(() => createDrizzleChain([stored]));
    const update = createDrizzleChain([]);
    update.set.mockImplementation((values: Partial<typeof stored>) => {
      stored = { ...stored, ...values };
      return createDrizzleChain([stored]);
    });
    mocks.update.mockReturnValue(update);
    const response = await PATCH(request(manifest), context);
    expect(response.status).toBe(200);
    expect((await response.json()).manifest).toEqual(manifest);
    expect(stored.metadata).toEqual(metadata);
    expect(update.set).toHaveBeenCalledWith({ metadata, updatedAt: expect.any(Date) });
    expect(revalidatePath).toHaveBeenCalledWith('/evt_edit');
    const reloaded = JSON.parse(JSON.stringify(stored.metadata)) as typeof metadata;
    expect(editableManifest(reloaded.fair)).toEqual(manifest);
  });

  it.each([null, { version: 'unknown' }, { ...feeManifestFixture(), chain: [null] }])(
    'rejects invalid or unsupported manifests without writing: %j', async (manifest) => {
      mocks.select.mockReturnValue(createDrizzleChain([makeEventRow()]));
      const response = await PATCH(request(manifest), context);
      expect(response.status).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('requires organizer authorization before writing', async () => {
    mocks.select.mockReturnValue(createDrizzleChain([makeEventRow()]));
    mocks.organizer.mockResolvedValue({ authorized: false });
    const response = await PATCH(request(feeManifestFixture()), context);
    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns authentication failures before reading event data', async () => {
    mocks.actor.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await PATCH(request(feeManifestFixture()), context)).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
