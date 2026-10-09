/**
 * GET /api/admin/events/export.csv — overview of every event as CSV (platform admin only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAdmin } from '@/lib/auth';
import { csvFileResponse } from '@/lib/csv-file-response';
import { failureResponse } from '@/lib/events-route-response';
import { buildAdminEventsCsv } from '@/services/admin-export-service';

const log = createLogger('events');

export async function GET(request: NextRequest) {
  const adminResult = await requireAdmin(request);
  if ('error' in adminResult) {
    return NextResponse.json({ error: adminResult.error }, { status: adminResult.status });
  }

  try {
    return csvFileResponse(await buildAdminEventsCsv());
  } catch (error) {
    return failureResponse(error, { fallback: 'Failed to export events', log });
  }
}
