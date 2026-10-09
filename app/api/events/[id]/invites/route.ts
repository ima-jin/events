/**
 * GET  /api/events/[id]/invites - List invites (owner/cohost only)
 * POST /api/events/[id]/invites - Create invite link (owner/cohost only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, eventInvites } from '@/db';
import { eq } from 'drizzle-orm';
import { requireActor, denyUnlessOrganizer } from '@/lib/route-guards';
import { randomBytes } from 'node:crypto';
import { eventUrl, buildPublicUrlAbsolute } from '@ima-jin/config';

const EVENTS_URL = buildPublicUrlAbsolute('events');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const { did } = actor;
  const denied = await denyUnlessOrganizer(request, id, did, 'Not authorized');
  if (denied) return denied;

  const invites = await db
    .select()
    .from(eventInvites)
    .where(eq(eventInvites.eventId, id));

  const withUrls = invites.map(inv => ({
    ...inv,
    url: `${eventUrl(EVENTS_URL, id)}?invite=${inv.token}`,
  }));

  return NextResponse.json({ invites: withUrls });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const { did } = actor;
  const denied = await denyUnlessOrganizer(request, id, did, 'Not authorized');
  if (denied) return denied;

  const body = await request.json();
  const { label, maxUses, expiresAt } = body;

  const inviteId = `inv_${randomBytes(12).toString('hex')}`;
  const token = randomBytes(16).toString('hex');

  const [invite] = await db
    .insert(eventInvites)
    .values({
      id: inviteId,
      eventId: id,
      token,
      label: label || null,
      maxUses: maxUses || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })
    .returning();

  return NextResponse.json({
    invite: {
      ...invite,
      url: `${eventUrl(EVENTS_URL, id)}?invite=${invite.token}`,
    },
  });
}
