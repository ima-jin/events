import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_HASH, BASELINE_WHEN, compareSchema, introspectSchema, runBaseline } from '../../lib/migrate-baseline-core.mjs';
import { insertRow } from '../../soak/load-dev.mjs';

// The ordinary setup-env DATABASE_URL is a dummy and must never enable this suite.
const testUrl = process.env.EVENTS_BASELINE_TEST_DATABASE_URL;
const folder = fileURLToPath(new URL('../../../migrations', import.meta.url));
const baselineSql = readFileSync(`${folder}/0000_events_schema.sql`, 'utf8');

describe.skipIf(!testUrl)('baseline real Postgres (dedicated disposable test database only)', () => {
  const sql = postgres(testUrl!, { max: 1, onnotice: () => {} });
  const run = (dryRun = false) => runBaseline(sql, { schema: 'events', migrationsFolder: folder, dryRun });
  const apply = () => sql.unsafe(baselineSql);
  const migrateApp = () => migrate(drizzle(sql), { migrationsFolder: folder, migrationsSchema: 'events' });
  beforeEach(async () => { await sql.unsafe('DROP SCHEMA IF EXISTS events CASCADE'); });
  afterAll(async () => { await sql.end(); });
  it('inserts soak JSON through postgres.js as a composite, preserving typed values', async () => {
    await apply();
    const row = {
      id: 'soak_event', did: 'did:imajin:soak-event', creator_did: 'did:imajin:soak-organizer',
      title: 'Soak "quoted" title', starts_at: '2026-10-15T12:34:56.000Z',
      ends_at: null, status: 'published', event_type: 'event', access_mode: 'public',
      registration_config: { enforce_unique_emails: true }, name_display_policy: 'attendee_choice',
      chat_enabled: false, currency: 'CAD', target_amount: 123,
      tags: ['soak', 'fixture'], metadata: { nested: { text: 'quoted "value"', list: [1, false, null] } },
    };
    await insertRow(sql, 'events', row);
    const [stored] = await sql.unsafe('SELECT * FROM events.events WHERE id = $1', [row.id]);
    expect(stored).toMatchObject({ ...row, starts_at: new Date(row.starts_at) });
    expect(stored.public_key).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.private_key).toMatch(/^[a-f0-9]{64}$/);

    await insertRow(sql, 'ticket_types', {
      id: 'soak_type', event_id: row.id, name: 'Standard', price: 100,
      currency: 'CAD', quantity: null, sort_order: 0, requires_registration: false,
      perks: ['Entry'], metadata: { nested: [true, null] },
    });
    expect(await sql.unsafe('SELECT event_id, price, quantity, perks, metadata FROM events.ticket_types')).toEqual([{
      event_id: row.id, price: 100, quantity: null, perks: ['Entry'], metadata: { nested: [true, null] },
    }]);
  });

  it('fresh database is untouched, then drizzle creates and revalidates the exact baseline', async () => {
    expect(await run()).toMatchObject({ status: 'fresh-database' });
    const [{ exists }] = await sql.unsafe("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'events') AS exists");
    expect(exists).toBe(false);
    await migrateApp();
    expect(await run()).toMatchObject({ status: 'already-baselined' });
    await migrateApp();
  });

  it('adopts existing tables, preserves data, validates repeated runs and makes migrate a no-op', async () => {
    await apply();
    expect(compareSchema(await introspectSchema(sql))).toEqual([]);
    await sql.unsafe("INSERT INTO events.events (id,did,public_key,creator_did,title,starts_at) VALUES ('sentinel','did:test','public','creator','Preserve me',now())");
    expect(await run(true)).toMatchObject({ status: 'would-baseline' });
    const [{ exists }] = await sql.unsafe("SELECT to_regclass('events.__drizzle_migrations') IS NOT NULL AS exists");
    expect(exists).toBe(false);
    expect(await run()).toMatchObject({ status: 'baselined' });
    expect(await run()).toMatchObject({ status: 'already-baselined' });
    expect(await run(true)).toMatchObject({ status: 'already-baselined' });
    await migrateApp();
    const rows = await sql.unsafe('SELECT hash, created_at FROM events.__drizzle_migrations');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ hash: BASELINE_HASH, created_at: String(BASELINE_WHEN) });
    expect(await sql.unsafe("SELECT title FROM events.events WHERE id='sentinel'")).toMatchObject([{ title: 'Preserve me' }]);
    await sql.unsafe("ALTER TABLE events.events ALTER COLUMN title DROP NOT NULL");
    await expect(run()).rejects.toThrow('columns mismatch');
  });

  it.each([
    "ALTER TABLE events.events ALTER COLUMN status SET DEFAULT 'other'",
    'ALTER TABLE events.events ADD COLUMN extra text',
    'ALTER TABLE events.events ALTER COLUMN title TYPE varchar(255)',
    'ALTER TABLE events.events DROP CONSTRAINT events_did_unique',
    'ALTER TABLE events.events ADD CONSTRAINT events_did_unique_2 UNIQUE NULLS NOT DISTINCT (did)',
    'ALTER TABLE events.orders DROP CONSTRAINT orders_event_id_events_id_fk; ALTER TABLE events.orders ADD FOREIGN KEY (event_id) REFERENCES events.events(id) ON DELETE CASCADE',
    'ALTER TABLE events.orders ALTER CONSTRAINT orders_event_id_events_id_fk DEFERRABLE',
    'ALTER TABLE events.orders DROP CONSTRAINT orders_event_id_events_id_fk; ALTER TABLE events.orders ADD FOREIGN KEY (event_id) REFERENCES events.events(id) NOT VALID',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status) WHERE status IS NOT NULL',
    'DROP INDEX events.idx_events_status; CREATE UNIQUE INDEX idx_events_status ON events.events(status)',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status DESC)',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status NULLS FIRST)',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status) INCLUDE (id)',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status text_pattern_ops)',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events(status COLLATE "C")',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events((lower(status)))',
    'DROP INDEX events.idx_events_status; CREATE INDEX idx_events_status ON events.events USING hash(status)',
    'CREATE TABLE events.stray (id text)',
  ])('refuses semantic drift without creating tracking: %s', async (mutation) => {
    await apply();
    await sql.unsafe(mutation);
    await expect(run()).rejects.toThrow('Refusing to baseline');
    await expect(run(true)).rejects.toThrow('Refusing to baseline');
    const [{ exists }] = await sql.unsafe("SELECT to_regclass('events.__drizzle_migrations') IS NOT NULL AS exists");
    expect(exists).toBe(false);
  });

  it.each(['timestamp', 'unknown', 'duplicate', 'extra'])('refuses recorded %s history without changing rows', async (kind) => {
    await apply();
    await run();
    if (kind === 'timestamp') await sql.unsafe('UPDATE events.__drizzle_migrations SET created_at = 0');
    if (kind === 'unknown') await sql.unsafe("UPDATE events.__drizzle_migrations SET hash = 'unknown'");
    if (kind === 'duplicate') await sql.unsafe('INSERT INTO events.__drizzle_migrations(hash,created_at) SELECT hash,created_at FROM events.__drizzle_migrations');
    if (kind === 'extra') await sql.unsafe("INSERT INTO events.__drizzle_migrations(hash,created_at) VALUES ('unknown',1)");
    const before = await sql.unsafe('SELECT * FROM events.__drizzle_migrations ORDER BY id');
    await expect(run()).rejects.toThrow('migration history');
    expect(await sql.unsafe('SELECT * FROM events.__drizzle_migrations ORDER BY id')).toEqual(before);
  });

  it('serializes concurrent baselines to one tracking row', async () => {
    await apply();
    const other = postgres(testUrl!, { max: 1, onnotice: () => {} });
    try {
      const results = await Promise.all([run(), runBaseline(other, { schema: 'events', migrationsFolder: folder })]);
      expect(results.map((result) => result.status).sort()).toEqual(['already-baselined', 'baselined']);
      expect(await sql.unsafe('SELECT * FROM events.__drizzle_migrations')).toHaveLength(1);
    } finally {
      await other.end();
    }
  });
});
