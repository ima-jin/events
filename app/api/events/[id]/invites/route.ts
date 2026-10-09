/**
 * GET  /api/events/[id]/invites - List invites (owner/cohost only)
 * POST /api/events/[id]/invites - Create invite link (owner/cohost only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, eventInvites } from '@/db';
import { eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { randomBytes } from 'node:crypto';
import { eventUrl, buildPublicUrlAbsolute } from '@ima-jin/config';
import { forbidUnlessOrganizer, type IdParams } from '@/lib/route-helpers';

const EVENTS_URL = buildPublicUrlAbsolute('events');

export async function GET(
  request: NextRequest,
  { params }: IdParams
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id } = await params;
  const did = resolveActingDid(authResult.identity);
  const forbidden = await forbidUnlessOrganizer(id, did, request, 'Not authorized');
  if (forbidden) return forbidden;

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
  { params }: IdParams
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id } = await params;
  const did = resolveActingDid(authResult.identity);
  const forbidden = await forbidUnlessOrganizer(id, did, request, 'Not authorized');
  if (forbidden) return forbidden;

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
