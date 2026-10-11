/**
 * GET /api/events/[id]/sales/export — one CSV line per order.
 * Query: ?format=xlsx (CSV content under a spreadsheet type — no xlsx library).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { csvFileResponse } from '@/lib/csv-file-response';
import { failureResponse } from '@/lib/events-route-response';
import { exportEventSales } from '@/services/sales-service';

const log = createLogger('events');

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const did = resolveActingDid(authResult.identity);
  const { id } = await params;

  try {
    const format = new URL(request.url).searchParams.get('format');
    const file = await exportEventSales(id, did, { format, callerCookie: request.headers.get('cookie') });
    return csvFileResponse(file);
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to export sales', log });
  }
}
