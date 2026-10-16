# Events cutover soak — #2529

Refs ima-jin/imajin-ai#2529 and epic ima-jin/imajin-ai#1988. The outcome is an organizer
creating an event, selling tickets, buyers receiving confirmations, and checking people in
through this standalone app, with no kernel-owned events implementation. Existing live
events must not be interrupted. A green tooling test is **not** a completed soak.

This PR supplies operator tooling only. It does not execute against real dev/prod, load
production data, rehearse the real host, or change issue acceptance. Ryan signs off #2529.
Use the sibling PII-scrubbed loader's dev dataset; do not copy production auth or secrets.

## Private input and target guards

Run from the standalone checkout with Node 22+. No new dependency or Playwright is used.
HTTP drives the available app contracts; a human browser handles hosted Stripe/QR/image
and delivery checks. Auth is read from an **owned regular 0600 JSON file**, not argv.
Symlinks and group/world-readable files are refused. Prepare it in a private editor
outside this checkout; never paste credentials into a shell command, terminal recording,
report or issue. Never generate or copy app self-secrets.

The private JSON accepts:

- `organizer` and `buyer`: header objects with `cookie`, `authorization`, `x-app-did`,
  `x-app-authorization` only. Use DEV test-account sessions/app tokens. Some legacy
  organizer/holder routes require sessions; use separate organizer and buyer sessions
  to exercise real authorization rather than organizer-as-buyer shortcuts.
- `fairManifest`: a valid `.fair` manifest with at least two distinct DEV
  `creator`/`contributor` payees. The runner patches only its newly created event.
  Without it the multi-seller check is **manual**, not passed.
- `oldTicket`: `{eventId, ticketId, token}` of a real pre-cutover, old-secret-signed
  ticket in the scrubbed dev dataset. The organizer must own/cohost that event.
  An invented invalid token does not prove the ruling-b transition.
- `newTicketTokens`: map of ticket ID to scanned raw QR token. In interactive mode,
  scan the new free RSVP ticket's image from the printed event URL, then update
  this same private file in an editor. The runner re-reads it while waiting.
- `publicEventId`: optional published sample (otherwise the public list supplies one).
- `existingTicket`: `{eventId, ticketId}` belonging to the buyer for prod-smoke lookup.
- `legacyUrls`: array of actual pre-move shared URL samples from loaded rows. Preserve
  their original path shape, but use the selected environment's origin. Do not invent
  a new `/e/` URL and call it legacy evidence. Do not include PII/query auth material.

An alternative `--legacy-urls` is a separate owned 0600 JSON file containing the URL
array. No database access is needed by the flow runner. It never reads other app schemas.
Only HTTPS `/events` targets are accepted; mutation mode additionally requires
`--env dev` and exact host `dev-jin.imajin.ai`. Redirects are bounded to five and
checked before following: same origin, approved path, GET/HEAD only. Write redirects
are refused, never replayed. Cookies are never forwarded off-origin.

## Dev flow pass

```bash
node scripts/soak/flow-pass.mjs --env dev \
  --base-url https://dev-jin.imajin.ai/events \
  --auth-file /private/path/events-soak-auth.json \
  --legacy-urls /private/path/events-legacy-urls.json \
  --interactive --timeout-seconds 300 --report /private/path/events-soak-results.md
```

Omit `--interactive` for an unattended HTTP contract pass. It still creates disposable
DEV events/holds/RSVPs and checkout/pledge setups; it is **not a dry run**. It marks
browser-dependent outcomes manual and never waits on stdin. Do not complete printed
checkout URLs from this mode afterward: the event is cancelled at the end. An interactive
rerun creates fresh fixtures. Report paths must be new (exclusive create, 0600).

Every step has pass/fail/manual, elapsed duration and a static safe note. No response
bodies, CSV rows, emails, DIDs, raw QR tokens, client secrets or full IDs enter the
markdown report; identifiers are omitted/redacted. The terminal additionally shows
validated TEST hosted checkout URLs and locally constructed event URLs for the operator.
Keep that terminal private; paste **only the report**, not the terminal transcript.
Exit status is 1 for any automated failure/refusal, 0 otherwise; **manual is not pass**.

### Flow coverage and remaining operator evidence

- **Automated:** health, callback signer discovery reachability, public API/list/page HTML,
  create/edit/publish event, three ticket tiers, optional multi-payee manifest round trip,
  hold/cancel an unconfirmed ticket, free RSVP, holder QR image retrieval, old QR rejection,
  organizer events/sales/guests and exports, authenticated dashboard HTML, event cancellation,
  campaign create/publish, test-mode checkout and SetupIntent evidence.
- **Observable notification bookkeeping:** request a confirmation resend for the newly
  created RSVP and poll its guest-list `lastEmailSentAt`. The buyer test account must
  have a resolvable DEV inbox. This timestamp records the request; publishing is best-effort
  and it does **not** prove provider acceptance, inbox delivery or notification UI delivery.
- **Browser-assisted automated (`--interactive`):** scan the newly issued QR into the private
  file; script submits check-in and asserts `usedAt`. Complete the **printed** hosted Stripe
  checkout with card **4242 4242 4242 4242**, a future expiry and any CVC. Script polls for a
  new two-ticket buyer order (payment effect), then its `.fair` receipt (settlement effect),
  verifies both configured seller payees have positive receipt amounts, refunds that
  newly observed order through events, and polls for refunded tickets.
- **Pledges:** the script creates a pending SetupIntent and checks kernel-returned `pk_test_`
  evidence; `seti_` alone has no test/live distinction. Open the printed campaign URL as the
  test buyer, complete its pending pledge through the normal UI with 4242, and confirm it.
  The UI may replace the pending SetupIntent while retaining the pledge ID. Check that
  the UI itself remains in TEST mode. The script polls that pledge ID for `confirmed`,
  settles the newly created campaign through its organizer route, and polls `charged`.
  It never outputs the SetupIntent client secret or calls Stripe directly.
- **Hard mode gate:** checkout must return `cs_test_` and a matching HTTPS
  `checkout.stripe.com` URL; a live/malformed session stops payment-dependent work.
  Pledge setup must return `pk_test_` and a SetupIntent client-secret shape; otherwise
  no campaign settle runs. Events uses its own app-service token against kernel pay,
  never Stripe credentials in this app.
- **Callback evidence:** only the real kernel may sign payment/settlement callbacks.
  The script never fabricates callbacks or calls confirm-payment fallbacks. A new order
  and receipt are observable effects; correlate their timing with the kernel's private
  callback audit when signing off. Campaign charge state is also written by its charge
  route, so `charged` alone is not proof of callback provenance. Discovery reachability
  alone does not prove signature trust. See [DEPLOY.md](./DEPLOY.md#kernel-signed-callbacks).
- **Manual:** taxes (hosted checkout address/rate/amount/total versus receipt), actual
  split accounting, browser appearance, embeds/consuming iframe, survey-dependent
  registration, seeded balance/e-transfer rails, and inbox/notification delivery for
  RSVP/payment/check-in/refund/cancel. This checkout has no events embed renderer or tax
  quote/delivery-status API. Fetching `?embed=true` is not embed evidence. Successful
  ticket creation is not email delivery evidence. Do not mark these passed without
  inspecting the real UI/inbox/receipt.
- **Legacy:** each supplied pre-move URL is fetched and its final HTML checked; HTTP
  failures (including a removed legacy path) are failures, not silently rewritten.
  Verify the actual shared URL's event and metadata in a browser as well.

Polling defaults to 180 seconds per human/state gate, configurable 1–900 seconds.
Timeouts fail the named step. No unobserved order is refunded and no unconfirmed pledge
is settled. Expect 30–90 seconds for HTTP-only checks and 10–20 minutes for a human-assisted
pass, plus provider delivery latency. These are **planning estimates, not measured results**.
Fixtures intentionally remain in dev for audit; no automatic database cleanup occurs.

## Read-only prod smoke
### Obtain the holder auth file

`--auth-file` is required and must contain a **signed-in production ticket-holder
session**, not an empty JSON file, an organizer-only session, an app identity/keystore,
or a dev session. Obtain it only through the normal, working standalone sign-in flow:

1. In a private browser session, sign in to the production events app as the approved
   holder of an existing ticket. Open that ticket's event and confirm the holder can
   see their ticket. Do not buy a ticket just to prepare automated smoke.
2. In the browser's Network panel, inspect the authenticated
   `/events/api/events/<eventId>/my-ticket` request. Privately copy its request
   `Cookie` header into the auth JSON's `buyer.cookie` field using an editor, never
   a shell command or exported HAR. Use the actual cookie names/values sent by the
   browser, not a guessed cookie name or a fabricated session.
3. Set `existingTicket` to `{ "eventId": "<existing-event-id>",
   "ticketId": "<ticket-owned-by-that-holder>" }` from that holder's ticket response.
   The file shape is `{ "buyer": { "cookie": "<private Cookie header>" },
   "existingTicket": { "eventId": "...", "ticketId": "..." } }`; these are placeholders,
   not usable credentials. Optional `publicEventId` and `legacyUrls` are described above.
4. Save outside the checkout as an operator-owned regular **0600** JSON file in a
   private directory (no symlink). Use its absolute path below. Keep both session and
   ticket identifiers out of logs, reports and issues; never copy app self-secrets.
   If the session expires or sign-in redirects recur, sign in again and refresh the
   file privately. No organizer session is needed for this read-only mode.

**Sign-in prerequisite / known blocker:** the 2026-10-16 cutover hit the standalone
login loop tracked in [imajin-ai#2825](https://github.com/ima-jin/imajin-ai/issues/2825).
The SDK fix is in `@ima-jin/auth-client` 0.8.21; app wiring is tracked separately in
[events#54](https://github.com/ima-jin/events/issues/54). This docs change does not
upgrade SDK pins or implement that wiring. Until working sign-in is deployed and a
holder session is obtained, authenticated prod smoke is **blocked**, not passed.
Do not bypass sign-in or omit `existingTicket` to claim success: without it, the
runner marks the ticket lookup **manual**, and exit 0 alone is not full smoke evidence.

### Run authenticated smoke after cutover

From `~/prod/events`, with the private holder file prepared above and a new report path:

```bash
cd ~/prod/events
node scripts/soak/flow-pass.mjs --env prod --prod-smoke \
  --base-url https://jin.imajin.ai/events \
  --auth-file /private/path/events-prod-smoke-auth.json \
  --report /private/path/events-prod-smoke-results.md
```

`--prod-smoke` is enforced again in the HTTP transport: **only GET/HEAD**, even if the
private fixture contains mutation inputs. It checks health, public list/page HTML,
legacy samples, an existing buyer-ticket projection, and signer discovery. Embeds remain
manual for the same reason as dev. It never creates, buys, refunds, cancels, confirms or
settles anything; `--interactive` cannot enable writes.

It prints the operator-only checklist: buy one real/comped ticket, refund it, validate
its QR. Those are separate approved human actions, not automated smoke actions.
### Public-read fallback when sign-in is blocked

Only unauthenticated public GET checks are available while the holder session cannot
be obtained. Set the public origin for the approved target (not from an env-file read):

```bash
EVENTS_PUBLIC_ORIGIN=https://jin.imajin.ai
curl --fail --silent --show-error --max-time 15 --output /dev/null \
  --write-out '/events: %{http_code}\n' "${EVENTS_PUBLIC_ORIGIN}/events"
curl --fail --silent --show-error --max-time 15 --output /dev/null \
  --write-out '/events/api/events: %{http_code}\n' "${EVENTS_PUBLIC_ORIGIN}/events/api/events"
```

Require **200 for both**; a redirect, error or timeout is not a pass. These commands
send no auth, do not follow redirects, discard response bodies and perform no writes.
Record only status codes/time and the sign-in blocker. Public reachability is **not**
holder-ticket authorization, authenticated prod smoke, or cutover/soak sign-off.
Rerun authenticated smoke once sign-in works; keep the holder lookup pending until then.

## Ruling b: QR cutover behavior

Ryan's 2026-10-14 ruling on #2516 supersedes #2529's old-QR compatibility sentence:
the kernel vault issues a **new** ticket QR secret at cutover.
existing ticket QRs are invalidated at cutover; no reissue

Never copy the old secret or carry it over into the vault. The expected dev flow is an
old genuine signed ticket token returning **400** with
`Invalid or expired ticket QR token`, not a 500 or successful admission. A newly issued
ticket's scanned token must check in successfully. Keep both results in #2529 evidence.
## Record, rollback, rehearse

Run as the host's existing process-manager user from canonical `~/dev/events`
or `~/prod/events`. Node 22+, git, pnpm 9.15.0, pm2 and curl are required.
**Install the standalone checkout's dependencies before `record`, even before its
first deploy:** `rollback.mjs` imports installed packages (including `postgres`) at
startup, so the deploy script's later install is too late if `node_modules` is absent.
From the selected clean standalone checkout, run:

```bash
cd ~/prod/events
pnpm install --frozen-lockfile
# For dev, use cd ~/dev/events and the same install command instead.
```

This installs dependencies only; it does not deploy, start pm2 or run migrations.
Do not run `record` until installation succeeds. Follow
[Before cutover: prepare and record](#before-cutover-prepare-and-record) for the
remaining prerequisites before recording.

A per-environment private lock prevents overlapping rollback operations; also prevent
concurrent deploys.
Never share `pm2 jlist`, `pm2 env` or pm2 dumps. The helper privately captures stdout/stderr
and never forwards raw subprocess/database errors. No tracing is enabled.

### Before cutover: prepare and record

1. Keep the kernel copy `~/<env>/imajin-ai/apps/events` and its dependencies and
   `.next/BUILD_ID` available. Kernel config #2804 released dev-events ownership;
   that is not a guarantee the historical app remains buildable. If missing,
   stop: the kernel operator must first restore a compatible checkout/build using
   the approved kernel build procedure (`pnpm --filter @imajin/events build` from
   `~/<env>/imajin-ai`), preserving that environment's private configuration.
   This script never builds/edits the kernel.
2. Complete approved standalone baseline adoption **before recording**, using the
   target's existing events-only database role and reviewed [migration procedure](./MIGRATIONS.md).
   Dry-run first; if adoption is needed, use `node --env-file=.env.local
   scripts/migrate-baseline.mjs` from the standalone checkout in the authorized window.
   The tracker is `events.__drizzle_migrations`. Recording before adoption makes its
   new baseline hash a post-record migration unknown to the kernel, and rollback refuses.
   There is deliberately **no baseline exception and no force bypass**.
3. Select the clean standalone checkout SHA intended for cutover/return. Record while
   the current pm2 events entry still points at the **kernel** app:

```bash
bash scripts/soak/rollback.sh dev record
# Separately, only in Ryan's approved prod cutover window:
bash scripts/soak/rollback.sh prod record
```

The record is `~/.imajin/events-rollback-<env>-<UTC timestamp>.json` (0600; parent
private 0700). It contains target/time, standalone HEAD, only migration names/hashes,
and only these pm2 fields: name, canonical cwd, executable, listener args,
allowlisted node args, env-file **path** and port. No env values or other process
definitions are saved. Unknown arguments/duplicate processes/noncanonical paths refuse.

Normal `record` is observed-only: it will not snapshot standalone as the rollback
destination. New normal records carry `source: "observed"`; older records without
that field are treated as observed. Preserve this pre-cutover record; the latest
validly named record for the selected environment is used.
Do not hand-edit it, overwrite it after cutover, or reuse another environment's record.
The script does not back up data: keep the operator's reviewed backup independently.
### Already cut over on dev, with no prior record

Dev was cut over before this tooling existed. Rather than hand-editing pm2, an operator
can explicitly record a synthesized kernel destination while the standalone app remains
running:

```bash
bash scripts/soak/rollback.sh dev record --post-cutover
bash scripts/soak/rollback.sh dev rehearse
```

This opt-in is **dev record only**. Prod refuses `--post-cutover` before any process
inspection and must still record the observed kernel definition **before** cutover.
The flag is not accepted for rollback/rehearse, takes no destination arguments, and is
not a force bypass.

Before saving, exactly one current `dev-events` must match the standalone definition:
cwd `~/dev/events`, executable `<cwd>/node_modules/next/dist/bin/next`,
args `start -p 3006`, and node args `--env-file=<cwd>/.env.local`. Missing, duplicated,
unknown, already-kernel, or mismatched definitions refuse without process changes.
The kernel destination is constructed **only** from canonical paths and the validated
dev context: `dev-events`, cwd `~/dev/imajin-ai/apps/events`, its Next executable,
args `start -p 3006`, and node args `--env-file=<kernel cwd>/.env.local`.
No destination value comes from pm2's arbitrary env fields or operator-supplied paths.

The kernel `.next/BUILD_ID` and executable must exist. Its `.env.local` must be an
operator-owned regular 0600 file, not a symlink; **only metadata is inspected, never
its values**. A missing build uses the same #2804 DECISION refusal. No secrets are
copied, and recording performs no pm2 mutations or database writes.

The private record carries `source: "post-cutover-synthesized"`, the current clean
standalone SHA, and the current read-only `events.__drizzle_migrations` snapshot.
This is an explicit **new recording boundary**, not evidence of pre-cutover state or
proof that the historical kernel supports every earlier migration. The operator must
approve compatibility of the retained kernel build before rehearsing. Migration
history shrinkage and unknown migrations applied **after** this record still refuse.
Synthesized records are also rejected on prod when read, and their destination fields
must remain exactly canonical.

`dev rehearse` then reuses this record, verifies rollback health, deploys the saved
standalone SHA through `scripts/deploy.sh dev <saved-SHA>`, and verifies that dev is
back on standalone. The timing report carries only the safe `source` label, not any
extra paths or env values. Keep the synthesized provenance in #2529's evidence; do
not describe it as an observed pre-cutover record.

### Roll back to the saved kernel copy

```bash
bash scripts/soak/rollback.sh dev rollback
# Same command with prod only in an authorized rollback window.
```

Before deleting anything, the helper requires a private record, current compatible
events process (or no events process after an interrupted transition), the saved kernel
build/executable/env-file path, and a non-shrunken migration history. Any post-record
hash must match SQL known to that kernel checkout's `migrations/*.sql`. It prints unknown
safe hashes and refuses otherwise; migrations are never undone or silently approved.

It deletes **only** `<env>-events`, starts the saved executable/cwd/args, runs `pm2 save`,
polls loopback `/events/api/health`, then public health using the standalone env file's
`NEXT_PUBLIC_EVENTS_URL` (fallback `NEXT_PUBLIC_APP_URL`). Health must be JSON
`status: ok`, service `events` (historical copy) or `imajin-events` (standalone).
Each endpoint allows 30 attempts, 5-second request timeout, 2-second retry delay.
It never edits Caddy, env files, application rows or any other process.

**Consequences remain:** tickets issued by standalone with its new QR secret will
not verify on the old kernel copy. Do not copy secrets to repair this. Kernel-copy
paid flows may fail closed if that copy has no claimed identity. Health alone does
not prove paid flows or data compatibility; verify with the approved test account.
Rollback uses the same events data, not a restore or a destructive migration.

### Dev rehearsal and return to standalone

```bash
bash scripts/soak/rollback.sh dev rehearse
```

Prod rehearsal is always refused. Before cutover this performs record → rollback →
roll forward; after cutover it **reuses the saved record**, either observed before
cutover or explicitly synthesized using the dev-only command above. It never replaces
the destination with a standalone definition or silently synthesizes one. No prior
record after cutover still means refusal: first run the explicit dev recording command.
Rehearsal preflights the clean standalone tree, tools, private env, saved SHA containing
`scripts/deploy.sh`, kernel build and migration history before the first deletion.

After verifying the kernel copy, it removes only events again (the deploy script
correctly refuses a stale kernel cwd) and runs `bash scripts/deploy.sh dev <saved-SHA>`.
That is the existing install/build/baseline/migrate/start/save path, not a new deployment
implementation. The saved SHA must include the approved deploy tooling. Finally it
checks pm2 is back at `~/dev/events`, then loopback and public health. A successful
rehearsal **must leave dev on standalone**.

If a rehearsal fails after process transition, it attempts the same recorded standalone
recovery and still exits nonzero. If recovery also fails, stop the cutover, retain the
record/data, inspect privately and use the approved saved-ref deployment/kernel restore
procedure. Do not repeatedly deploy across unknown migrations. A killed process can
leave `~/.imajin/events-rollback-<env>.lock`; inspect process state privately before
removing a stale lock and retrying. An absent events process can be restored from
the record, but an unknown or duplicate events definition refuses.

### Timing and evidence

Expect record/preflight in 1–10 seconds; pm2 delete/start/save in 2–15 seconds;
healthy rollback in 5–30 seconds; full dev rehearsal in roughly **2–8 minutes**,
dominated by install/build/migration/roll-forward. Health failure can take about
208 seconds per endpoint (30 × 5 seconds + 29 × 2 seconds). Build timeout is 30 minutes.
These are estimates, **not a claim of measured host rehearsal** or zero downtime.

Rehearsal writes `~/.imajin/events-rehearsal-dev-<UTC timestamp>.json` (0600) on
success or failure. It includes the validated record `source`, `status`, `durationMs`, `steps` with safe labels/status/
duration, and an optional structured build `decision`, without pm2/env values, raw
errors, refs or paths. Recovery command outcomes appear in the step sequence.
Rollback and rehearsal both print per-command elapsed times. Attach only the report's
safe timing summary to #2529, with actual UTC window, kernel/standalone refs and the
post-rehearsal flow pass. A missing kernel build is an operator decision, not a reason
to change the kernel in this PR:

`DECISION · kernel events build · Which compatible kernel build can be retained for dev rehearsal? · options a restore/build approved historical app/b defer window/c abandon rollback target · rec: a — rehearse a real compatible target before approving cutover`

## Results template for #2529

Paste the generated markdown table, then complete:

- Standalone head / kernel head / scrubbed loader dataset version: …
- Environment and UTC window: …
- Automated failure count / remaining manual count: …
- Multi-tier + multi-seller receipt / taxes (no PII): …
- Inbox confirmations and notification delivery observed: …
- Old QR 400 / new QR successful check-in: …
- Actual legacy shared URLs resolve to correct events (omit private URLs): …
- Embed and registration UI checked: …
- Real rollback/rehearsal record timestamp and measured per-step timings: …
- Record provenance (`observed` or `post-cutover-synthesized`): …
- Standalone restored, public health, post-rehearsal purchase/check-in: …
- Data continuity checked before/after (counts/state only, no personal data): …
- Ryan sign-off: pending.

Unresolved operator decisions use:
`DECISION · subject · question · options a/b/c · rec: letter — reason`

Do not close #2529 from this PR. A fixture rehearsal validates tooling, not the live-host
acceptance: “The rollback has been rehearsed on dev, and the steps and timing are written down.”
