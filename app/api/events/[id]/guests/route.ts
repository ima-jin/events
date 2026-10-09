import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { requireAppAuth } from '@ima-jin/auth';
import { corsHeaders } from '@ima-jin/config';
import { listEventGuests } from '@/services/guests-service';
import { isServiceError } from '@/services/errors';

const log = createLogger('events');

/**
 * GET /api/events/[id]/guests — list all tickets with profile info (owner or cohost)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  let did: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    did = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    did = resolveActingDid(authResult.identity);
  }

  const { id } = await params;

  try {
    return NextResponse.json(await listEventGuests(id, did, request.headers.get('cookie')));
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Failed to fetch guests');
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}
