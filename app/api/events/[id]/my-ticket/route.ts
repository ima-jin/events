import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';

import { requireAuth, resolveActingDid } from '@/lib/auth';
import { getBuyerTickets } from '@/services/buyer-tickets-service';
const log = createLogger('events');


/**
 * GET /api/events/:id/my-ticket - Check if user has access to this event
 * Returns hasAccess: true if user has a ticket OR is an organizer (host/cohost/owner)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ hasTicket: false, hasAccess: false });
  }

  const { identity } = authResult;
  const did = resolveActingDid(identity);
  const { id: eventId } = await params;

  try {
    return NextResponse.json(await getBuyerTickets(eventId, did, request.headers.get('cookie')));
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to check event access');
    return NextResponse.json({ error: 'Failed to check event access' }, { status: 500 });
  }
}
