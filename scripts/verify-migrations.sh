#!/usr/bin/env bash
# verify-migrations.sh <database-url> <schema>
#
# Run after `pnpm db:migrate` against an empty database. Asserts that:
#   1. the app's schema exists and holds exactly the expected events tables
#      (plus drizzle's own migration-tracking table), and
#   2. nothing was created in any other non-system schema (including
#      `public` and drizzle's default `drizzle` schema).
set -euo pipefail

DATABASE_URL="${1:?usage: verify-migrations.sh <database-url> <schema>}"
SCHEMA="${2:?usage: verify-migrations.sh <database-url> <schema>}"

EXPECTED_TABLES="__drizzle_migrations event_invites events orders pledges ticket_queue ticket_transfers ticket_types tickets"

# The query goes in over stdin: psql only interpolates :'schema' there, not in --command.
query() {
  printf '%s\n' "$1" | psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --set schema="$SCHEMA"
}

# Sort both sides with the same locale-independent ordering (Postgres's own
# collation would put `tickets` and `ticket_*` in a different order than sort).
actual_tables="$(query "SELECT table_name FROM information_schema.tables WHERE table_schema = :'schema'" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
expected_tables="$(printf '%s\n' $EXPECTED_TABLES | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"

if [ "$actual_tables" != "$expected_tables" ]; then
  echo "::error::Tables in schema '$SCHEMA' do not match."
  echo "  expected: $expected_tables"
  echo "  actual:   $actual_tables"
  exit 1
fi
echo "OK: schema '$SCHEMA' contains: $actual_tables"

stray="$(query "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema <> :'schema' ORDER BY 1")"
if [ -n "$stray" ]; then
  echo "::error::Tables found outside schema '$SCHEMA':"
  echo "$stray"
  exit 1
fi
echo "OK: no tables outside schema '$SCHEMA'"
