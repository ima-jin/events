/**
 * GET /api/attending/[did]
 * Returns upcoming events that a DID has tickets for.
 * Used by profile page to show upcoming events.
 *
 * Privacy:
 *   - public events: shown to anyone
 *   - invite_only events: shown to the authenticated owner or ticket holder
 *   - viewer_did is not an authentication credential and is ignored
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { optionalAuth } from '@/lib/auth';
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

  try {
    const identity = await optionalAuth(request);
    return NextResponse.json(await listAttendingEvents(ownerDid, identity?.id ?? null));
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Failed to fetch attending events');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
