import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { buildGuestCsv, getGuestSummary } from '@/services/guests-service';
import { isServiceError } from '@/services/errors';

const log = createLogger('events');

/**
 * GET /api/events/[id]/guests/export.csv — export guest list as CSV
 * Query params:
 *   ?includeCancelled=1 — include cancelled/refunded tickets
 *   ?summary=1          — return JSON summary instead of CSV
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const did = resolveActingDid(authResult.identity);
  const { id } = await params;

  const { searchParams } = new URL(request.url);
  const options = {
    includeCancelled: searchParams.get('includeCancelled') === '1',
    callerCookie: request.headers.get('cookie'),
  };

  try {
    if (searchParams.get('summary') === '1') {
      return NextResponse.json(await getGuestSummary(id, did, options));
    }

    const { filename, content } = await buildGuestCsv(id, did, options);
    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Failed to export guest list');
    return NextResponse.json({ error: 'Failed to export guest list' }, { status: 500 });
  }
}
