/**
 * GET /api/attending/[did]
 * Returns upcoming events that a DID has tickets for.
 * Used by profile page to show upcoming events.
 *
 * Privacy:
 *   - public events: shown to anyone
 *   - invite_only events: only shown if viewer_did also has a ticket
 *
 * Query params:
 *   - viewer_did: optional DID of the viewer (for invite_only privacy check)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { listAttendingEvents } from '@/services/guests-service';
import { isServiceError } from '@/services/errors';

const log = createLogger('events');

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const ownerDid = decodeURIComponent(did);
  const viewerDid = request.nextUrl.searchParams.get('viewer_did') || null;

  try {
    return NextResponse.json(await listAttendingEvents(ownerDid, viewerDid, request.headers.get('cookie')));
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Failed to fetch attending events');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
