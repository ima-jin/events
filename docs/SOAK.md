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

```bash
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

## Ruling b: QR cutover behavior

Ryan's 2026-10-14 ruling on #2516 supersedes #2529's old-QR compatibility sentence:
the kernel vault issues a **new** ticket QR secret at cutover.
existing ticket QRs are invalidated at cutover; no reissue

Never copy the old secret or carry it over into the vault. The expected dev flow is an
old genuine signed ticket token returning **400** with
`Invalid or expired ticket QR token`, not a 500 or successful admission. A newly issued
ticket's scanned token must check in successfully. Keep both results in #2529 evidence.

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
- Standalone restored, public health, post-rehearsal purchase/check-in: …
- Data continuity checked before/after (counts/state only, no personal data): …
- Ryan sign-off: pending.

Unresolved operator decisions use:
`DECISION · subject · question · options a/b/c · rec: letter — reason`

Do not close #2529 from this PR. A fixture rehearsal validates tooling, not the live-host
acceptance: “The rollback has been rehearsed on dev, and the steps and timing are written down.”
