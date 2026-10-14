import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { generateQRCode } from '@/lib/email';
import { and, eq } from 'drizzle-orm';
import { db, tickets } from '@/db';
import { requireActor } from '@/lib/route-guards';

const log = createLogger('events');

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;
  const params = await props.params;
  try {
    const [ticket] = await db.select({ id: tickets.id }).from(tickets)
      .where(and(eq(tickets.id, params.id), eq(tickets.ownerDid, actor.did))).limit(1);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }
    const qrCodeDataUri = await generateQRCode(params.id);
    if (!qrCodeDataUri) {
      return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
    }
    return NextResponse.json({ qrCodeDataUri }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    log.error({ err: String(error) }, 'QR generation error');
    return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
  }
}
