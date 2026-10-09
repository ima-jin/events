/**
 * GET /api/events/[id]/sales
 *
 * Sales (orders + orphan tickets) for an event: SalesTab JSON, or a CSV / XLSX-as-CSV
 * download with `?format=csv|xlsx`. Auth: event creator or co-host.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { csvFileResponse } from '@/lib/csv-file-response';
import { failureResponse } from '@/lib/events-route-response';
import { getEventSales } from '@/services/sales-service';

const log = createLogger('events');

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const did = resolveActingDid(authResult.identity);
  const { id: eventId } = await params;

  try {
    const format = new URL(request.url).searchParams.get('format');
    const result = await getEventSales(eventId, did, { format, callerCookie: request.headers.get('cookie') });
    return result.kind === 'file' ? csvFileResponse(result.file) : NextResponse.json(result.report);
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to fetch sales', log, logFields: { eventId } });
  }
}
