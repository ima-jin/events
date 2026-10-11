/**
 * DELETE /api/events/[id]/invites/[inviteId] - Revoke invite (owner only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, eventInvites } from '@/db';
import { eq, and } from 'drizzle-orm';
import { requireActor, denyUnlessOrganizer } from '@/lib/route-guards';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;

  const { id, inviteId } = await params;
  const { did } = actor;

  const denied = await denyUnlessOrganizer(request, id, did, 'Not authorized');
  if (denied) return denied;

  const deleted = await db
    .delete(eventInvites)
    .where(and(eq(eventInvites.id, inviteId), eq(eventInvites.eventId, id)))
    .returning();

  if (!deleted.length) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
