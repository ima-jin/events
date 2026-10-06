import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EXPECTED_TABLES = [
  'event_invites',
  'events',
  'orders',
  'pledges',
  'ticket_queue',
  'ticket_transfers',
  'ticket_types',
  'tickets',
];

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

async function loadSchema() {
  vi.resetModules();
  return import('../schema');
}

describe('events schema ownership', () => {
  const originalSchema = process.env.APP_DB_SCHEMA;

  beforeEach(() => {
    process.env.APP_DB_SCHEMA = 'events';
  });

  afterEach(() => {
    if (originalSchema === undefined) {
      delete process.env.APP_DB_SCHEMA;
    } else {
      process.env.APP_DB_SCHEMA = originalSchema;
    }
  });

  it('throws at import when APP_DB_SCHEMA is not set', async () => {
    delete process.env.APP_DB_SCHEMA;
    await expect(loadSchema()).rejects.toThrow('APP_DB_SCHEMA is not set');
  });

  it('defines exactly the events tables, all in the APP_DB_SCHEMA schema', async () => {
    const schema = await loadSchema();
    const tables = [
      schema.events,
      schema.ticketTypes,
      schema.orders,
      schema.tickets,
      schema.ticketTransfers,
      schema.ticketQueue,
      schema.eventInvites,
      schema.pledges,
    ].map((table) => getTableConfig(table));

    expect(tables.map((t) => t.name).sort()).toEqual(EXPECTED_TABLES);
    for (const table of tables) {
      expect(table.schema).toBe('events');
    }
  });

  it('only references tables inside its own schema via foreign keys', async () => {
    const schema = await loadSchema();
    const config = getTableConfig(schema.tickets);
    expect(config.foreignKeys.length).toBeGreaterThan(0);
    for (const fk of config.foreignKeys) {
      expect(getTableConfig(fk.reference().foreignTable).schema).toBe('events');
    }
  });

  it('follows APP_DB_SCHEMA rather than a hard-coded schema name', async () => {
    process.env.APP_DB_SCHEMA = 'events_dev';
    const schema = await loadSchema();
    expect(getTableConfig(schema.events).schema).toBe('events_dev');
  });
});

describe('committed migrations', () => {
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
  const sql = sqlFiles.map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf-8')).join('\n');

  it('creates the events schema before any table', () => {
    expect(sqlFiles.length).toBeGreaterThan(0);
    const createSchema = sql.indexOf('CREATE SCHEMA IF NOT EXISTS "events"');
    const firstTable = sql.indexOf('CREATE TABLE');
    expect(createSchema).toBeGreaterThanOrEqual(0);
    expect(createSchema).toBeLessThan(firstTable);
  });

  it('creates every expected table', () => {
    for (const table of EXPECTED_TABLES) {
      expect(sql).toContain(`CREATE TABLE "events"."${table}"`);
    }
  });

  it('never touches a schema other than events', () => {
    const qualified = [...sql.matchAll(/"([a-z_]+)"\."[a-z_]+"/g)].map((m) => m[1]);
    expect(qualified.length).toBeGreaterThan(0);
    for (const schemaName of qualified) {
      expect(schemaName).toBe('events');
    }
    expect(sql).not.toMatch(/CREATE TABLE\s+"?[a-z_]+"?\s*\(/);
  });
});
