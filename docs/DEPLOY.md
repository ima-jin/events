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

**Upgrade order (each environment separately):** deploy a kernel that includes
ima-jin/imajin-ai#2801, then select **Sync manifest secrets** on `/jin` and countersign
events' `imajin.app.json` declarations **before upgrading this app**. Skipping that
order makes a claimed app fail closed at boot with exit status 1. Fresh provision/claim
issues and seals the declarations through the kernel. No deployment is performed by this PR.

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
Kernel-signed callbacks additionally require trusted util-linux `/usr/bin/flock` and persistent
writable storage shared by all local workers (see below).
Only one deploy per checkout at a time. The script verifies the canonical standalone cwd and
refuses a same-named pm2 entry with a different cwd or executable. It prints no env values.

1. Preflight tools, clean tracked tree, env file, standalone cwd and pm2 definition.
2. Clear inherited contract variables so `.env.local` is authoritative; fetch/check out ref.
3. `node scripts/check-env.mjs <dev|prod>` checks required variables, target URLs,
   `0600` files, disabled ticket migration, and forbidden key/logging vars. Without a
   keystore it only warns: claim at `/events/claim` after boot.
4. `pnpm install --frozen-lockfile` installs only this repo's published dependencies.
5. Build with `.env.local` loaded. `NEXT_PUBLIC_*` changes always require this rebuild.
6. Run `scripts/migrate-baseline.mjs`, then drizzle migrate with the same env file.
7. Start/restart only `<env>-events` using this repo's ecosystem file; **`pm2 save`**.
   Without a keystore, the server boots unclaimed. The operator claims only at
   `/events/claim`; the published SDK persists the bootstrap keystore and activates
   the app immediately, without an env edit or restart.
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

- Put `IMAJIN_APP_DID` and `NEXT_PUBLIC_IMAJIN_APP_ID` (registry id) in the target checkout's
  `.env.local` via a private editor. After boot, paste the one-time operator code
  from `/jin` only at `/events/claim`, never into an environment file or shell.
- Use `IMAJIN_APP_KEYSTORE=/home/jin/.imajin/events.dev.keystore.json` or
  `/home/jin/.imajin/events.prod.keystore.json`. Prepare a private parent directory
  (`0700`) owned by `jin`. The SDK writes the bootstrap keystore `0600`; the actual
  app signing key stays memory-only. Preserve the keystore across deploys.
- Subsequent boots authenticate with the keystore. Loss requires operator approval with
  `reissueClaim: true`, not hand-made replacement keys.
- The operator must approve `pay:settle`, `pay:refund` and `pay:charge-pledges` for events'
  app DID via the `apps:service-scopes` approval card.
  Organizer messages additionally require `notify:broadcast` on that same app DID.
  User app tokens use audience **`events`**, with `events:read` / `events:write`;
  they do not use the kernel hostname as audience. The session-cookie fallback remains
  a migration path, not a substitute for scoped-token verification.
- Configure `IMAJIN_APP_ATTESTATION_ID` when enabling app-auth service calls outside
  user sessions. Existing integration limitations are in [KERNEL-GAPS.md](./KERNEL-GAPS.md).
  Deploy kernel PR imajin-ai#2786 **first**, then this events release, and remove the
  retired shared pay credential from the host environment. Refunds and campaign charges
  use only events' own app token and require kernel-recorded app ownership. Legacy unbound
  campaign setups must be recreated and confirmed (events#27); never manufacture bindings.
  A 401 triggers one re-mint; 403 scope/ownership errors fail closed without retry.

Keep credentials out of shell history, terminal recordings, PRs and logs. Do not use
`set -x`, print `.env.local`, share `pm2 env`, `pm2 jlist` or the pm2 dump: these may contain
secrets. The deploy preflight consumes pm2 JSON privately and prints no environment values.

### Database and payment preparation

Use the existing environment's `events` schema and a Postgres role granted access **only**
to that schema. A shared database is acceptable with a schema-scoped role; no access to
kernel/other-app tables is required. `APP_DB_SCHEMA=events` is fixed. Back up this schema
before adoption (retain/restore with the database operator; never force a mismatched baseline).

App self-secrets are kernel-issued and sealed from `imajin.app.json`; provision/claim,
or use **Sync manifest secrets** on `/jin` and countersign for an existing registration.
Never generate, reveal, copy or populate app self-secrets in an env file.
The kernel signs callbacks; events verifies public keys, with no shared callback credential.

Before changing pm2:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run
```

This validates without recording history. A refusal is a hard stop; no destructive
repair, no migration SQL rewrite, no force flag.

## One-time cutover — deferred to #2529 / #2516
existing ticket QRs are invalidated at cutover; no reissue

Use [SOAK.md](./SOAK.md) for the #2529 scripted flow pass, private test inputs,
manual evidence gates and rollback rehearsal/results template. Tooling tests do not
replace the real authorized dev rehearsal or Ryan's sign-off.
For #2529's loader-only production-shaped dev dataset, follow
[SOAK-DATA.md](./SOAK-DATA.md): Ryan-operated read-only export, guarded dev dry run/commit,
retained snapshot and restore. This is not production cutover or permission to run it.

Per Ryan's 2026-10-14 ruling on ima-jin/imajin-ai#2516, the kernel vault issues a new
ticket QR secret at cutover. Never copy the old secret or carry it over into the vault.

Kernel dev process ownership was released in ima-jin/imajin-ai#2804. Confirm the
target environment's kernel deploy config no longer declares the monorepo events entry
**before** starting standalone, so a later kernel deploy cannot re-point it. Ownership
release does not preserve a buildable `apps/events`: retain/prepare the compatible
kernel rollback build separately as described in [SOAK.md](./SOAK.md). This PR makes
no kernel changes.

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

See [SOAK.md](./SOAK.md) for `scripts/soak/rollback.sh <dev|prod> <record|rollback|rehearse>`,
safe pre-cutover recording, migration/build refusal paths, timings and dev roll-forward.
Caddy stays unchanged: first-cutover rollback re-points only the events pm2 process.

`bash scripts/deploy.sh <env> <previous-tag-or-sha>` rebuilds and restarts the prior standalone
release. Migrations are forward-only; do not roll code back across an incompatible migration.
For first-cutover rollback, use the coordinated kernel cutover runbook and saved configuration,
then `pm2 save`. Restore data only through the operator's reviewed database backup procedure.

Baseline mismatch: stop and review catalog differences; nothing was adopted. Invalid identity:
review DID/claim/keystore names privately; ask Ryan for reissue if needed. Payment failure:
confirm the registered service scope and webhook configuration, never add an internal key.

## Kernel-signed callbacks

Deploy a kernel with signed app callbacks (imajin-ai#2800 / #2798) **before** this receiver.
The kernel operator completes the approved vault/tool setup for its signer and re-syncs the
registered events app and service scopes through `/jin`; no kernel key or internal credential
is copied into events. Verify the callback registration for both `/events/api/webhook/payment`
and `/events/api/webhook/settlement` on the target public origin and app DID.
Complete dev verification before an approved prod rollout; these are operator steps, not CI actions.

The app verifies exact body bytes before JSON parsing or business processing with
`verifyKernelWebhook` from the published `@ima-jin/auth/kernel-webhook` **0.8.18**.
The expected audience is trusted local `process.env.IMAJIN_APP_DID`, not an inbound header
or the user-token audience slug. `authServiceUrl` comes from `serviceUrl('auth')`;
public discovery uses `{authServiceUrl}/.well-known/kernel-signing-key` over HTTPS.
The SDK pins public keys on first use; rotation requires overlap with existing trusted pins.
Never delete pins to work around a trust failure.

Preserve `data/kernel-webhook-pins/` (SDK public pins) and `data/kernel-webhook-nonces/`
(app durable nonce store) beneath the process cwd across restarts, deploys and rollbacks.
The nonce adapter atomically updates `data/kernel-webhook-nonces/nonces.json`, pruning expired
entries on each consumption; its 100,000-entry capacity fails closed. The SDK/app creates its
storage directories. Never remove a live journal or pin files to bypass replay or trust checks.
The process user needs writable persistent local filesystem storage, shared by every local
worker, and trusted Linux `/usr/bin/flock` from util-linux for atomic cross-process locking.
Do not use ephemeral release-local data directories. No database schema change is needed.
Before adding multi-host replicas, supply a shared-store adapter with atomic insert-if-absent,
expiry and coordinated pin locking; independent host-local stores cannot reject cross-host replay.
Use `configureEventsWebhookNonceStore` to inject that shared nonce adapter; public pins must also
use the same trusted namespace with coordinated storage/locking.

Signatures bind audience, timestamp, nonce, HTTP method, public path/query and exact body bytes.
The inclusive freshness window is ±300 seconds and each nonce is accepted only once, including
across local workers and restarts. Retries must be freshly signed with a new nonce. Caddy must
preserve the `/events` prefix, query, body bytes and all five `x-kernel-*` headers.
Signature/audience/freshness/replay failures return **401**; correctly signed invalid JSON
returns **400**; discovery, trust or storage failure returns **503** without business side effects.
