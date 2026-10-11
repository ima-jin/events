import { NextRequest, NextResponse } from 'next/server';
import { tiersErrorResponse } from '@/lib/tiers-route-helpers';
import { unlockTiers } from '@/services/ticket-types-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events/[id]/tiers/unlock?code=XXXX
 *
 * Returns ticket types matching the given access code (case-insensitive).
 * No auth required. Used to reveal hidden/staff/VIP ticket tiers.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  try {
    return NextResponse.json({ tiers: await unlockTiers(id, searchParams.get('code')) });
  } catch (error) {
    return tiersErrorResponse(error, 'Failed to unlock tiers');
  }
}
