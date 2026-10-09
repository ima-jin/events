import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { corsHeaders, getClientIP, rateLimit } from '@ima-jin/config';
import { db, events } from '@/db';
import { requireAuth, resolveActingDid } from '@/lib/auth';

/** Shared building blocks of the crowdfunding campaign routes (CORS, rate limit, auth, event lookup). */

/** Builds the `OPTIONS` preflight handler every campaign route exports. */
export function createPreflight() {
  return (request: NextRequest) => new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/** JSON `{ error }` response carrying the route's CORS headers. */
export function jsonError(message: string, status: number, cors: HeadersInit): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: cors });
}

/** 429 response when the caller's IP exceeded `limit` requests per minute, otherwise null. */
export function rateLimitResponse(request: NextRequest, limit: number, cors: HeadersInit): NextResponse | null {
  const rl = rateLimit(getClientIP(request), limit, 60_000);
  if (!rl.limited) return null;
  return NextResponse.json(
    { error: 'Too many requests', retryAfter: rl.retryAfter },
    { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
  );
}

/** Authenticate the caller and resolve the DID they act as, or the error response to return as-is. */
export async function authenticateDid(request: NextRequest, cors: HeadersInit): Promise<string | NextResponse> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return jsonError(authResult.error, authResult.status, cors);
  }
  return resolveActingDid(authResult.identity);
}

/** The `{eventId}` segment of `/api/campaign/{eventId}/<action>` (second from the end). */
export function pathEventId(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/').at(-2);
}

/** The event row for `eventId`, or undefined. */
export async function findEvent(eventId: string) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return event;
}
