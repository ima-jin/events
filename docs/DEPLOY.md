# Deploying events (dev + prod)

Refs ima-jin/imajin-ai#2518; this change prepares deployment only. Ryan mints the app identity through
the kernel claim flow; dev/prod cutover remains in #2529/#2516.

Events runs from `~/dev/events` as `dev-events` on port **3006**, and from `~/prod/events` as
`prod-events` on port **7006**. These are the existing listener ports in
`ima-jin/imajin-ai/deploy/ecosystem.dev.config.js` and `deploy/ecosystem.prod.config.js`.
Caddy keeps the kernel host's `/events` path prefix intact.

Deployment must use the registered-app contract: separate kernel-minted identities per environment,
published `@ima-jin/*` packages, scoped tokens and the public kernel API. No kernel checkout is a
build dependency, and no signing key belongs in an environment file or log.

After re-pointing a pm2 entry to the standalone checkout, the operator must run **`pm2 save`**.
On 2026-10-10 a reboot resurrected stale kernel copies of market, learn, coffee and dykil because
the persisted process list still referenced the old checkouts.

## One command per environment

On the **ProLiant kernel host**, as its existing `jin` process-manager user, from the target
standalone checkout:

```bash
bash scripts/deploy.sh dev
# Later, only after #2529 sign-off and Ryan's approved #2516 window:
bash scripts/deploy.sh prod
# Reproducible release or rollback (same syntax in dev):
bash scripts/deploy.sh prod <tag-or-sha>
```

Default ref is `origin/main`; the script fetches and checks out the ref detached, never pulls
over local changes. Required tools: Node 22+ (see `.nvmrc`), pnpm 9.15.0, git, pm2, curl.
Only one deploy per checkout at a time. The script verifies the canonical standalone cwd and
refuses a same-named pm2 entry with a different cwd or executable. It prints no env values.

1. Preflight tools, clean tracked tree, env file, standalone cwd and pm2 definition.
2. Clear inherited contract variables so `.env.local` is authoritative; fetch/check out ref.
3. `node scripts/check-env.mjs <dev|prod>` checks required variables, target URLs, keystore or
   first-boot claim code, `0600` files, disabled ticket migration, and forbidden key/logging vars.
4. `pnpm install --frozen-lockfile` installs only this repo's published dependencies.
5. Build with `.env.local` loaded. `NEXT_PUBLIC_*` changes always require this rebuild.
6. Run `scripts/migrate-baseline.mjs`, then drizzle migrate with the same env file.
7. Start/restart only `<env>-events` using this repo's ecosystem file; **`pm2 save`**.
   The first server boot claims through `instrumentation.ts` → published
   `loadAppSigningKey()`; there is no separate raw-key generation or claim script.
8. Poll loopback `/events/api/health` for `status: ok`, `service: imajin-events`.

Any failure before step 7 leaves pm2 alone. This is an in-place build, **not an atomic
zero-downtime release**: `.next` changes during the build. Schedule an appropriate deployment
window; keep the previous ref and backups for rollback. Health proves boot, not payment,
database or end-to-end correctness; the #2529 soak remains mandatory.

## Prepare a fresh checkout (Ryan/operator)

Do not execute these steps as part of the code/docs PR.

```bash
git clone https://github.com/ima-jin/events.git ~/dev/events
cd ~/dev/events
cp .env.dev.example .env.local
chmod 600 .env.local
# Populate privately using ENVIRONMENTS.md; remove unused blank optional entries.
node scripts/check-env.mjs dev
```

For prod use `~/prod/events`, `.env.prod.example`, and `prod`. Never copy the dev identity,
claim code, secrets, database URL or keystore into prod. Do not copy an old kernel `.env.local`
wholesale (it may carry forbidden internal keys). No kernel source is needed to build events.

### Identity and scope preparation

For **each** kernel host (`dev-jin.imajin.ai`, then `jin.imajin.ai`), Ryan approves
`apps.provision` through that kernel's `/jin` approval card. Use the registered slug `events`,
callback `/events/api/auth/callback` on that environment's public origin, and appropriate
registered scopes. Do not use the legacy registry create response that exposes a private key.
See [REGISTRATION.md](./REGISTRATION.md).

- Put `IMAJIN_APP_DID`, `NEXT_PUBLIC_IMAJIN_APP_ID` (registry id), and first-boot
  `IMAJIN_APP_CLAIM_CODE` in the target checkout's `.env.local` via a private editor.
- Use `IMAJIN_APP_KEYSTORE=/home/jin/.imajin/events.dev.keystore.json` or
  `/home/jin/.imajin/events.prod.keystore.json`. Prepare a private parent directory
  (`0700`) owned by `jin`. The SDK writes the bootstrap keystore `0600`; the actual
  app signing key stays memory-only. Preserve the keystore across deploys.
- After successful first boot, **delete** `IMAJIN_APP_CLAIM_CODE` from `.env.local`.
  Subsequent boots authenticate with the keystore. Loss requires operator approval with
  `reissueClaim: true`, not hand-made replacement keys.
- Approve events' `pay:settle` service scope via the `apps:service-scopes` approval card.
  User app tokens use audience **`events`**, with `events:read` / `events:write`;
  they do not use the kernel hostname as audience. The session-cookie fallback remains
  a migration path, not a substitute for scoped-token verification.
- Configure `IMAJIN_APP_ATTESTATION_ID` when enabling app-auth service calls outside
  user sessions. Existing integration limitations are in [KERNEL-GAPS.md](./KERNEL-GAPS.md).
  Refund/charge-pledges still depend on the legacy key (#2735); this deploy work does not
  resolve or authorize that boundary gap. Never mint a shared key as a workaround.

Keep credentials out of shell history, terminal recordings, PRs and logs. Do not use
`set -x`, print `.env.local`, share `pm2 env`, `pm2 jlist` or the pm2 dump: these may contain
secrets. The deploy preflight consumes pm2 JSON privately and prints no environment values.

### Database and payment preparation

Use the existing environment's `events` schema and a Postgres role granted access **only**
to that schema. A shared database is acceptable with a schema-scoped role; no access to
kernel/other-app tables is required. `APP_DB_SCHEMA=events` is fixed. Back up this schema
before adoption (retain/restore with the database operator; never force a mismatched baseline).

Privately populate `SESSION_SECRET` and `WEBHOOK_SECRET` with independently generated
32-byte random values per environment. The pay service's corresponding `EVENTS_WEBHOOK_SECRET`
must match `WEBHOOK_SECRET`; its callback is
`https://<environment-kernel-host>/events/api/webhook/payment`, authenticated by
`Authorization: Bearer` (not a body secret or `x-webhook-secret`). These are secrets, **not**
app signing keys. Do not log webhook headers.

Before changing pm2:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run
```

This validates without recording history. A refusal is a hard stop; no destructive
repair, no migration SQL rewrite, no force flag.

## One-time cutover — deferred to #2529 / #2516

The kernel deploy configs currently still declare monorepo events entries. Their ownership
must be removed/reconciled by the kernel cutover work **before** a standalone entry is started,
otherwise a subsequent kernel deploy can re-point it. This PR makes no kernel changes.

At Ryan's authorized dev window (prod only after dev soak sign-off):

1. Verify backups, dry-run baseline, registration and `.env.local`; record the previous ref.
2. Coordinate the kernel deploy/pm2 ownership transition for events.
3. Inspect only cwd/executable fields locally. If the old entry points at
   `~/<env>/imajin-ai/apps/events`, explicitly `pm2 delete <env>-events && pm2 save`.
   The deploy script never deletes an existing process automatically.
4. Run the one-command deploy from `~/<env>/events`; verify public health and the full soak.
5. Verify pm2 cwd is the standalone checkout and **run `pm2 save` again after any manual
   re-pointing**. A restart alone does not update what a reboot resurrects.

Keep `ENABLE_TICKET_MIGRATION` unset or `false` until the #2529 soak is signed off.
The prepared deploy preflight deliberately refuses `true`; enabling a live-row rewrite needs
a separate reviewed cutover change, not an incidental deployment.

## Caddy — preserve the existing prefix

Do not replace the kernel site or switch to subdomains. In the existing site blocks,
the effective routes remain:

```caddy
# Existing jin.imajin.ai site block:
@events path /events /events/*
handle @events {
    reverse_proxy localhost:7006
}
# Existing dev-jin.imajin.ai site block:
@events path /events /events/*
handle @events {
    reverse_proxy localhost:3006
}
```

Use `handle`, **not `handle_path`**: the app's `NEXT_PUBLIC_BASE_PATH=/events` needs the
prefix intact. All other kernel routes stay unchanged.
Public checks: `https://dev-jin.imajin.ai/events/api/health` and
`https://jin.imajin.ai/events/api/health`.

## Rollback and refusal

`bash scripts/deploy.sh <env> <previous-tag-or-sha>` rebuilds and restarts the prior standalone
release. Migrations are forward-only; do not roll code back across an incompatible migration.
For first-cutover rollback, use the coordinated kernel cutover runbook and saved configuration,
then `pm2 save`. Restore data only through the operator's reviewed database backup procedure.

Baseline mismatch: stop and review catalog differences; nothing was adopted. Invalid identity:
review DID/claim/keystore names privately; ask Ryan for reissue if needed. Payment failure:
confirm the registered service scope and webhook configuration, never add an internal key.
