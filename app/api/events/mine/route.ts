import { NextResponse } from 'next/server';
import { withLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { failureResponse } from '@/lib/events-route-response';
import { listCreatorEvents } from '@/services/events-service';

/**
 * GET /api/events/mine - Get all events created by authenticated user
 */
export const GET = withLogger('events', async (request, { log }) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  try {
    const events = await listCreatorEvents(resolveActingDid(authResult.identity));
    return NextResponse.json({ events });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to fetch events', log });
  }
});
