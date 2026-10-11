import { NextResponse } from 'next/server';
import { withLogger } from '@ima-jin/logger';
import { requireAppAuth } from '@ima-jin/auth';
import { corsHeaders } from '@ima-jin/config';
import { authenticateAppOrSession } from '@/lib/app-or-session';
import { failureResponse } from '@/lib/events-route-response';
import { createEvent, listEvents, type CreateEventInput } from '@/services/events-service';

/**
 * POST /api/events - Create a new event
 * Requires hard DID (keypair-based identity)
 */
export const POST = withLogger('events', async (request, { log, correlationId }) => {
  const cors = corsHeaders(request);
  const auth = await authenticateAppOrSession(request, cors, { appScope: 'events:write', requireHardIdentity: true });
  if (auth instanceof NextResponse) return auth;

  try {
    const input = (await request.json()) as CreateEventInput;
    const result = await createEvent({
      creatorDid: auth.did,
      identityId: auth.identity.id,
      input,
      correlationId,
      actingAs: auth.identity.actingAs,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to create event', log });
  }
});

/**
 * GET /api/events - List events
 * Supports: ?courseSlug=intro-to-ai&upcoming=true&status=published&limit=20
 */
export const GET = withLogger('events', async (request, { log }) => {
  const cors = corsHeaders(request);
  const { searchParams } = new URL(request.url);

  const isAppCall = Boolean(request.headers.get('x-app-did'));
  // CORS headers are only sent on the legacy registered-app path (kernel behaviour).
  const headers = isAppCall ? cors : undefined;

  if (isAppCall) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
  }

  try {
    const events = await listEvents({
      status: searchParams.get('status'),
      limit: Number.parseInt(searchParams.get('limit') || '20'),
      courseSlug: searchParams.get('courseSlug'),
      upcoming: searchParams.get('upcoming') === 'true',
      audience: isAppCall ? 'app' : 'public',
    });
    return NextResponse.json({ events }, { headers });
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to list events', log, logFields: { appAuth: isAppCall }, headers });
  }
});
