import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@ima-jin/config';
import type { Logger } from '@ima-jin/logger';
import { db, events } from '@/db';

/** CORS preflight for the campaign endpoints. */
export function campaignOptions(request: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/** `eventId` for `/api/campaign/{eventId}/<action>` routes. */
export function pathEventId(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/').at(-2);
}

/** 429 response when the caller's IP exceeded `limit` requests this minute, else null. */
export function limitRequests(request: NextRequest, cors: HeadersInit, limit: number): NextResponse | null {
  const rl = rateLimit(getClientIP(request), limit, 60_000);
  if (!rl.limited) return null;
  return NextResponse.json(
    { error: 'Too many requests', retryAfter: rl.retryAfter },
    { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
  );
}

interface LoadOptions {
  /** Reject events that are not campaigns (400). Default true. */
  campaignOnly?: boolean;
  /** Require the caller to be the creator, else 403 with `forbiddenMessage`. */
  creator?: { did: string | null; forbiddenMessage: string };
}

/** Load the campaign event for a request, or the ready-to-return 400/403/404 response. */
export async function loadCampaignEvent(
  eventId: string | undefined,
  cors: HeadersInit,
  { campaignOnly = true, creator }: LoadOptions = {}
): Promise<typeof events.$inferSelect | NextResponse> {
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: cors });

  if (!eventId) return fail('eventId is required', 400);

  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return fail('Event not found', 404);
  if (campaignOnly && event.eventType !== 'campaign') return fail('Not a campaign event', 400);
  if (creator && event.creatorDid !== creator.did) return fail(creator.forbiddenMessage, 403);
  return event;
}

/** Log and return the standard 500 for a failed campaign operation. */
export function campaignFailure(
  log: Logger,
  err: unknown,
  label: string,
  message: string,
  cors: HeadersInit
): NextResponse {
  log.error({ err: String(err) }, label);
  return NextResponse.json({ error: message }, { status: 500, headers: cors });
}
