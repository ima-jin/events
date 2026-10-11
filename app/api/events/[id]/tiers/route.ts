import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { requireAppAuth } from '@ima-jin/auth';
import { corsHeaders } from '@ima-jin/config';
import { tiersErrorResponse } from '@/lib/tiers-route-helpers';
import { createTier, listPublicTiers, updateTier } from '@/services/ticket-types-service';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/events/[id]/tiers - List public ticket tiers (excludes access-code-protected)
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const cors = corsHeaders(request);
  const { id } = await params;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    try {
      return NextResponse.json({ tiers: await listPublicTiers(id) }, { headers: cors });
    } catch (error) {
      return tiersErrorResponse(error, 'Failed to list tiers', {
        headers: cors,
        logMessage: 'Failed to list tiers (app auth)',
      });
    }
  }

  try {
    return NextResponse.json({ tiers: await listPublicTiers(id) });
  } catch (error) {
    return tiersErrorResponse(error, 'Failed to list tiers');
  }
}

/**
 * POST /api/events/[id]/tiers - Create a new tier
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const actorDid = resolveActingDid(authResult.identity);
  const { id } = await params;

  try {
    const tier = await createTier({
      eventId: id,
      actorDid,
      callerCookie: request.headers.get('cookie'),
      readBody: () => request.json(),
    });
    revalidatePath(`/${id}`);
    return NextResponse.json({ tier }, { status: 201 });
  } catch (error) {
    return tiersErrorResponse(error, 'Failed to create tier');
  }
}

/**
 * PUT /api/events/[id]/tiers - Update a tier (append-only rules)
 */
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const actorDid = resolveActingDid(authResult.identity);
  const { id } = await params;

  try {
    const { tier, changed } = await updateTier({
      eventId: id,
      actorDid,
      callerCookie: request.headers.get('cookie'),
      readBody: () => request.json(),
    });
    if (!changed) {
      return NextResponse.json({ tier, message: 'No changes' });
    }
    revalidatePath(`/${id}`);
    return NextResponse.json({ tier });
  } catch (error) {
    return tiersErrorResponse(error, 'Failed to update tier');
  }
}
