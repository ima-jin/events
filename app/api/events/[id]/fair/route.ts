import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { revalidatePath } from 'next/cache';

const log = createLogger('events');
import { db, events } from '@/db';
import { requireActor } from '@/lib/route-guards';
import { isEventOrganizer } from '@/lib/organizer';
import { eq } from 'drizzle-orm';
import { validateManifest } from '@ima-jin/fair';

/**
 * PATCH /api/events/[id]/fair - Update the .fair manifest for an event
 * Requires auth as creator or admin.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;

  const { did } = actor;
  const { id } = await params;

  try {
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const orgCheck = await isEventOrganizer(id, did, request);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized to update this event' }, { status: 403 });
    }

    const body = await request.json();
    const { manifest } = body;

    const { valid, errors } = validateManifest(manifest);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid .fair manifest', errors }, { status: 400 });
    }

    const updatedMetadata = { ...(event.metadata as Record<string, unknown>), fair: manifest };

    const [updated] = await db
      .update(events)
      .set({ metadata: updatedMetadata, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    revalidatePath(`/${id}`);

    return NextResponse.json({ event: updated, manifest });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update .fair manifest');
    return NextResponse.json({ error: 'Failed to update manifest' }, { status: 500 });
  }
}
