/**
 * GET /api/campaign/{eventId}/my-pledge
 *
 * Returns the current user's pledge for a campaign, if any.
 * Requires auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { db, pledges } from '@/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@ima-jin/config';
import { withLogger } from '@ima-jin/logger';

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const GET = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }

  const did = resolveActingDid(authResult.identity);

  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const eventId = pathParts.at(-2); // /api/campaign/{eventId}/my-pledge

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    const [pledge] = await db
      .select({
        id: pledges.id,
        amount: pledges.amount,
        status: pledges.status,
      })
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          eq(pledges.backerDid, did)
        )
      )
      .limit(1);

    return NextResponse.json({ pledge: pledge || null }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'My pledge error');
    return NextResponse.json(
      { error: 'Failed to get pledge' },
      { status: 500, headers: cors }
    );
  }
});
