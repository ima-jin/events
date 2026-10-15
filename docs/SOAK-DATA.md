# Production-shaped dev data — #2529

This is the **loader-only** operator procedure for the standalone `ima-jin/events` app.
It does not deploy, perform cutover, rewrite live tickets, reissue QRs, or authorize production
changes. Ryan owns production execution under ima-jin/imajin-ai#2516; agents must not connect
to production or inspect real environment files. See [DEPLOY.md](./DEPLOY.md) for deployment.

## Preparation and isolation

Run on the server as **`jin`**, from `/home/jin/dev/events`, using **Node 22** and
**pnpm 9.15.0**, with this reviewed loader revision and its frozen-lockfile dependencies.
The exporter accesses only the app's eight `events` tables, in a read-only repeatable-read
transaction; it never queries kernel/other-app schemas. Schedule production reads with Ryan
so the export's load and snapshot lifetime are acceptable; do not stop or interrupt production.

Ryan/DBA must prepare a private regular **`0600`** source env file outside the checkout,
containing `DATABASE_URL` and `APP_DB_SCHEMA=events`. **Strongly prefer a dedicated read-only
source role**, created separately by Ryan/DBA, limited to schema usage and SELECT on these
eight tables. Read-only transactions are defense in depth, not a substitute for role isolation.
Do not create roles or grants through this loader.

The target env file is `/home/jin/dev/events/.env.local`, also a private regular **`0600`**
file. It must explicitly select `IMAJIN_ENV=dev`, `APP_DB_SCHEMA=events` and database
**`imajin_dev`**. No production marker is permitted in `IMAJIN_ENV`, `NODE_ENV`, `APP_ENV`,
`ENVIRONMENT`, `DEPLOY_ENV` or `NEXT_PUBLIC_IMAJIN_ENV`. The target URL endpoint and resolved
server/database must differ from the export source. These checks do not authorize a target:
Ryan must independently confirm the dev connection and schema ownership.

Before **both load and restore**, pause all dev writers/processes (including `dev-events`,
workers, scheduled jobs and other dev consumers), webhook delivery/retries and other side
effects. Isolate live payment and email behavior, including kernel-facing calls: use only
approved dev/sandbox integrations, with no route to production charges, refunds, settlements,
pledge collection or real outbound mail. Scrubbed IDs are not a side-effect firewall.
Keep writers paused through validation, commit/restore and operator verification; the advisory
lock serializes loaders, not application writers. Do not change production processes.

The dev role needs schema usage, SELECT/INSERT/TRUNCATE and locking rights on the eight
tables, plus **CREATE on database `imajin_dev`** to create a backup schema and ownership/CREATE
rights within that schema. A regular runtime role may intentionally lack these privileges:
Ryan/DBA must arrange a suitable dev-only operator role separately, not broaden production
or runtime access. Ensure space for a full retained copy of current dev data.

Prepare credentials only through approved private file editing/provisioning. Never put URLs,
passwords, key material or env values in CLI arguments, shell-generated files, shell history
or logs; do not `source`/print env files, use `set -x`, or paste raw driver errors. No app or
kernel signing/session/QR secret belongs in the source env file.

## Export and load commands

The following paths are examples of private operator-selected locations, not credentials.
The output path must be **new/nonexistent**: the exporter creates it as `0700`, refuses an
existing directory (including a symlink), and writes files as `0600`. Its parent must already
exist and be private/owned by `jin`. Do not pre-create the output directory.

**1. Ryan executes the production export**, not the agent:

```bash
node scripts/soak/export-prod-shaped.mjs --source-env-file /home/jin/.config/events/soak-source.env --out /home/jin/soak/events-NEW
```

Optionally append `--did-map /home/jin/.config/events/soak-did-map.json`. That private `0600`
JSON object maps **production DID → dev DID**, using valid `did:imajin:…` strings. Target DIDs
must be unique (no merging identities). It is sensitive linkage data: keep it outside the repo,
artifacts and logs. Unmapped DIDs are pseudonymized; no reverse map or per-export salt is saved.

**2. Load only into dev**, first without `--commit`:

```bash
node scripts/soak/load-dev.mjs --target-env-file /home/jin/dev/events/.env.local --in /home/jin/soak/events-NEW
```

This is a **dry run by default**: file/manifest and read-only target validation, planned counts,
no snapshot/truncation/insertion. After successful review and isolation, repeat that exact
load command with **`--commit`** appended. Never point it at a prod env file. Record only the
reviewed revision, scrub version, counts, validation outcome and printed backup schema name
in the private operator record, not row data or credentials.

## Artifact and transformation contract

The directory contains one JSONL file for each of `events`, `ticket_types`, `orders`, `tickets`,
`ticket_transfers`, `ticket_queue`, `event_invites` and `pledges`, plus `manifest.json`.
Each JSONL line is a scrubbed row. The manifest records format/scrub versions, export time,
schema, a catalog fingerprint, hashed source endpoint/server identities, per-table row counts
and SHA-256 checksums of the exact file bytes. The manifest is written only after all eight
tables export successfully and the read-only transaction commits. A partial directory without
its manifest is not usable; retry into another new private directory.

Loading checks exact table/column coverage, versions, counts, checksums and the target schema
fingerprint (columns/types/defaults, constraints and indexes). It checks file modes and refuses
symlink inputs. Committed loading rechecks catalog under exclusive locks and validates bytes
again during insertion. Checksums detect changed files; they are not a signature or proof that
an untrusted manifest is authentic. Keep custody of the whole private directory.

IDs are pseudonymized consistently within an export, preserving local foreign-key relationships;
email/URL/token/payment/external identifiers are neutralized according to the versioned
[`policy.mjs`](../scripts/soak/policy.mjs). Arbitrary metadata and settlement JSON keys are
neutralized as well as values, so external registration and settlement bindings do not survive.
Registration configuration is restricted to its reviewed safe allowlist. Public display content
may be retained by policy; this is production-shaped test data, not a guarantee that every
visible field is anonymous. Do not publish artifacts or treat external pseudonyms as valid
kernel records. The per-column policy is authoritative; do not hand-maintain a parallel policy.

**Neither event private nor public keys are exported.** On load, every event receives a fresh
keypair using the same app helper, `src/lib/event-keypair.mjs`, as ordinary event creation.
Historical ticket/transfer signatures are neutralized and **invalid**, not re-signed proofs.
The old kernel ticket QR secret is never copied, exported, or reconstructed. Existing ticket
QRs are invalidated at cutover; **no reissue**, per Ryan's #2516 ruling. The loader never reads
the vault or provisions replacement secrets; normal approved registration/cutover owns that.

## Atomic replacement and retained snapshot

With `--commit`, a session advisory lock serializes loaders. In a separate committed transaction,
the loader exclusively locks the eight dev tables and snapshots their current rows into a
retained database schema named **`events_soak_backup_<timestamp>_<suffix>`**. This is not a
filesystem dump. Schema and table privileges are revoked from `PUBLIC`; ownership and any
explicit/default role grants still require Ryan/DBA review. The snapshot contains **previous
dev data**, including previous dev event keys; protect it as sensitive dev data.

Only after snapshot success does one replacement transaction lock and revalidate the target,
`TRUNCATE` all eight tables with **`RESTART IDENTITY`**, then insert parent-first. It never uses
`CASCADE`, touches a migration-history table, or replaces another schema. The classified schema
currently has **no sequences**: identity/generated columns or `nextval` defaults are refused as
schema drift, not repaired or silently reseeded. Migration metadata is not part of the dataset.

If replacement fails, that transaction rolls back and the already committed snapshot is
retained. If snapshot creation fails, replacement has not started. A successful load also
retains the snapshot. Keep writers paused and review the reported outcome; do not blindly
retry, delete a backup or assume a missing success line proves rollback after a lost connection.
Only Ryan/DBA should authorize later retention cleanup after sign-off.

## Restore the exact pre-load dev snapshot

Use the same reviewed loader/policy revision and original private artifact directory. Keep dev
writers/webhooks and all side effects paused as above. This restores **previous dev rows and
their dev keys**, not production keys or a new scrubbed export. It does not restore schema DDL,
sequence state, migration history or changes made after the snapshot.

From `/home/jin/dev/events`, replace only the non-secret `backup` literal below with the exact
retained name printed by the loader, and `directory` with the original artifact directory.
The guard refuses the placeholder or any name outside the loader's naming pattern. The command
loads env privately through Node, then reads/validates the same `0600` file with common helpers;
it does not use inherited connection values. No database URL appears on the command line.

```bash
node --env-file=/home/jin/dev/events/.env.local --input-type=module <<'NODE'
import postgres from 'postgres';
import {
  assertDirectory, assertTarget, environment, quote, readManifest, refuse,
  tableList, tableSql, transaction,
} from './scripts/soak/common.mjs';
import { validateManifest, validateTarget } from './scripts/soak/load-dev.mjs';
import { POLICY, TABLES } from './scripts/soak/policy.mjs';

const backup = 'events_soak_backup_REPLACE_WITH_RETAINED_NAME';
const directory = '/home/jin/soak/events-NEW';

async function restore() {
  refuse(!/^events_soak_backup_\d{13}_[a-f0-9]{8}$/.test(backup),
    'Invalid retained backup schema name.');
  await assertDirectory(directory);
  const manifest = await readManifest(`${directory}/manifest.json`);
  validateManifest(manifest);
  const env = await environment('/home/jin/dev/events/.env.local');
  assertTarget(env, manifest); // Exact dev + imajin_dev + events; no prod markers/source endpoint.
  const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {}, debug: false });
  try {
    const sql = await client.reserve();
    try {
      await transaction(sql, true, (tx) => validateTarget(tx, env, manifest));
      await sql.unsafe("SELECT pg_advisory_lock(hashtext('events-soak-loader'))");
      try {
        await transaction(sql, false, async (tx) => {
          await tx.unsafe(`LOCK TABLE ${tableList()} IN ACCESS EXCLUSIVE MODE`);
          await validateTarget(tx, env, manifest); // Resolved source exclusion + fingerprint.
          const backupTables = TABLES.map((table) => tableSql(table, backup)).join(', ');
          await tx.unsafe(`LOCK TABLE ${backupTables} IN ACCESS EXCLUSIVE MODE`);
          // Check every retained table is readable before any destructive operation.
          for (const table of TABLES) {
            const columns = Object.keys(POLICY[table]).map(quote).join(', ');
            await tx.unsafe(`SELECT ${columns} FROM ${tableSql(table, backup)} LIMIT 0`);
          }
          await tx.unsafe(`TRUNCATE TABLE ${tableList()} RESTART IDENTITY`);
          // POLICY supplies explicit columns (including previous dev keys), never SELECT *.
          // TABLES is parent-first: events, ticket_types, orders, tickets,
          // ticket_transfers, ticket_queue, event_invites, pledges.
          for (const table of TABLES) {
            const columns = Object.keys(POLICY[table]).map(quote).join(', ');
            await tx.unsafe(`INSERT INTO ${tableSql(table)} (${columns})
              SELECT ${columns} FROM ${tableSql(table, backup)}`);
          }
        });
        console.log('Restored previous dev rows; retained backup unchanged.');
      } finally {
        await sql.unsafe("SELECT pg_advisory_unlock(hashtext('events-soak-loader'))");
      }
    } finally {
      sql.release();
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

await restore().catch(() => {
  console.error('Restore failed; details withheld. Keep dev paused and review with Ryan/DBA.');
  process.exitCode = 1;
});
NODE
```

All eight table locks, truncation and explicit-column `INSERT … SELECT` operations run in one
transaction. Failure rolls back that transaction; the backup is neither changed nor dropped.
There is no `CASCADE`. Confirm the restore outcome and dev-only integration isolation privately
before resuming dev traffic. On connection loss, independently establish transaction outcome.

## Refusals and handling

Stop on permissions, unsafe target/source identity, checksum/count, scrub-version, unexpected
column/sequence or fingerprint mismatch. Have Ryan/DBA review role rights or schema alignment.
**No force override**; never edit JSONL, manifest, catalog, migration records or policy to bypass
a refusal, recalculate checksums by hand, or copy production env/keystore/vault material into dev.
Use a fresh export after a reviewed policy/schema change. Preserve a failed run's private
artifacts and retained backup for authorized review; never paste their contents into issues.
