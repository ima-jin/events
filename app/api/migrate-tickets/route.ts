import { getIdentityTier } from '@/lib/kernel';
/**
 * POST /events/api/migrate-tickets
 *
 * Migrate tickets from soft DIDs to a hard DID after the kernel verifies the
 * buyer's email. Idempotent — safe to call multiple times.
 *
 * Auth: a scoped app token carrying `events:write` (`requireAppAuth`). The
 * kernel version accepted an optional shared `INTERNAL_SECRET` and failed OPEN
 * when it was unset; this one always fails closed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { db, tickets } from '@/db';
import { and, inArray, sql } from 'drizzle-orm';
import { migrateChatParticipation } from '@/lib/chat-sync';
import { requireAppAuth } from '@ima-jin/auth';

const log = createLogger('events');

/** Owner DIDs whose kernel tier is soft (or unknown) — only those tickets migrate. */
async function filterSoftDids(ownerDids: string[], hardDid: string): Promise<string[]> {
  const candidates = ownerDids.filter((did) => did !== hardDid);
  const tiers = await Promise.all(candidates.map((did) => getIdentityTier(did)));
  return candidates.filter((_, i) => !tiers[i] || tiers[i] === 'soft');
}

export async function POST(request: NextRequest) {
  const appResult = await requireAppAuth(request, { scope: 'events:write' });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status });
  }

  try {
    const { email, hardDid } = await request.json();

    if (!email || !hardDid) {
      return NextResponse.json({ error: 'email and hardDid are required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Candidate tickets: purchaseEmail matches and the owner is not already
    // the hard DID. Softness is then checked against the kernel's public
    // identity tier (never `auth.identities` directly).
    const candidates = await db
      .select({ id: tickets.id, ownerDid: tickets.ownerDid })
      .from(tickets)
      .where(
        and(
          sql`${tickets.metadata}->>'purchaseEmail' = ${normalizedEmail}`,
          sql`${tickets.ownerDid} != ${hardDid}`
        )
      );

    const softDids = await filterSoftDids(
      Array.from(new Set(candidates.map((t) => t.ownerDid).filter((did): did is string => Boolean(did)))),
      hardDid
    );
    const softTickets = candidates.filter((t) => t.ownerDid !== null && softDids.includes(t.ownerDid));

    if (softTickets.length === 0) {
      log.info({ email: normalizedEmail, hardDid }, 'No soft DID tickets to migrate');
      return NextResponse.json({ migrated: 0 });
    }

    // Migrate all matching tickets to hard DID
    await db
      .update(tickets)
      .set({ ownerDid: hardDid })
      .where(
        inArray(
          tickets.id,
          softTickets.map((t) => t.id)
        )
      );

    log.info(
      { count: softTickets.length, softDids, hardDid, email: normalizedEmail },
      'Migrated tickets from soft DIDs to hard DID'
    );

    await migrateChatParticipation(softDids, hardDid, log);

    return NextResponse.json({ migrated: softTickets.length });

  } catch (error) {
    log.error({ err: String(error) }, 'migrate-tickets error');
    return NextResponse.json({ error: 'Migration failed' }, { status: 500 });
  }
}
