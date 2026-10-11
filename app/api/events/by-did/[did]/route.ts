/**
 * GET /api/events/by-did/[did]
 * Look up an event by its DID. Used by chat service to resolve event names.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { failureResponse } from '@/lib/events-route-response';
import { findEventByDid } from '@/services/events-service';

const log = createLogger('events');

export async function GET(_request: NextRequest, { params }: { params: Promise<{ did: string }> }) {
  const { did } = await params;

  try {
    const event = await findEventByDid(decodeURIComponent(did));
    return NextResponse.json({ event });
  } catch (error) {
    return failureResponse(error, { fallback: 'Internal error', log });
  }
}
