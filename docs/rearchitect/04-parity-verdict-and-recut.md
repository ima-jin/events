# 04 - Parity verdict and re-cut of the five steps

## 1. Verdict: is events#2's kernel-parity port the base?

**No. events#2 is superseded as the base of the re-architecture.**

It stays a draft and is not merged. It is kept as a read-only quarry: domain logic and behavioural tests are moved out of it into the layers in `02-proposed-architecture.md`, and when the build has taken what it needs the draft is closed with a link to the PRs that did. Parity is retained as a goal, but as a behaviour reference (the parity set in `02` section 8, enforced by a characterization suite), not as the architecture. This is the design's recommendation (decision card D01); it becomes binding when Ryan ratifies the design. Nothing here changes events#2 itself.

### Why it cannot be the base

Each point is a fact from `01-current-state.md` section 10 unless noted.

1. It cannot deliver the outcome. Buyer confirmations come from kernel bus reactors, and its `publish()` is a logged no-op because no public route exists; `createOnboardToken()` always returns null. An organizer could create an event and sell a ticket, and the buyer would receive nothing.
2. There is no UI. The only page is the template's `app/page.tsx`; the 13 pages and 31 components of the real app are not ported, so create-event, buy and check-in have no operator-visible surface.
3. It fails open by design. Every kernel helper returns null or an empty list on any failure. A kernel outage or a missing kernel route silently turns "organizer" into "not an organizer" and "has a pod" into "no pods", and there is nothing to tell an operator why. The `docs/KERNEL-GAPS.md` that the code cites for these cases does not exist on the branch.
4. It carries every finding forward. The `sold` constants (F01), the unauthenticated registration and upload routes (F04, F05), the shared-secret webhooks (F06), the stored private keys (F02) and the settlement authority inversion (F08) are all ported unchanged.
5. It is red. At its last CI run 18 of 28 test files fail (module resolution, a logger mock without `createLogger`, a test that reads a sibling kernel checkout), and SonarCloud reports 49 open issues and a failing gate on that PR. Fixing a 14,779-line base to green first is review cost spent on code the design replaces in shape.
6. Its PR base is `main`, which contradicts the ruling that PRs target `rearchitect`. Retargeting is for its owner.

### What is worth taking from it

- Behavioural knowledge in the helpers: checkout pricing and hold handling, e-Transfer handling, free checkout, refund rules, guest export formatting, tier helpers, markdown excerpt, contact-email handling. These move into `src/domain` and `src/use-cases`, with the SQL and `fetch` calls replaced by store and port calls.
- The tests as scenarios. They are re-pointed at domain functions and use cases with port fakes; the ones that need a kernel checkout on disk are rewritten around pinned fixtures.
- The idea of a single kernel seam, generalized from one catch-all file into typed ports with explicit failure policy.
- `requireSessionOrAppToken` adoption (events#2 `src/lib/auth.ts`), folded into `authenticate()`.

### What is not taken

The route-per-kernel-route layout with SQL and `fetch` inline, the fail-open helper semantics, the `IMAJIN_EVENTS_PUBLISH_PATH` environment switch, and the `PORT-2515.md` tracker.

## 2. Re-cut of the five steps

Principles for the re-cut: no milestone is assigned until Ryan ratifies the design (as #1988 already states); nothing merges to `main`, deploys, or prunes the kernel before the prod cutover sign-off; every build PR targets `rearchitect`; and every `gap(kernel)` in `05-kernel-gaps.md` that a slice depends on is named in that slice.

### #2515 re-cut: build the app on the ports instead of porting routes at parity

Re-title and re-scope #2515 from "port routes at kernel parity" to "build the events app on the ports in the design, reaching behavioural parity for the parity set". Deliver it as vertical slices, each its own PR into `rearchitect` and each with the full gate set green and zero new SonarCloud issues: first the skeleton (the `authenticate()` seam, ports with fakes and the HTTP adapter shells, the outbox and dispatcher, the template sync, the schema-scoped database role in CI); then create-event and tiers; then free checkout through `issueTickets` with queued confirmations (the first slice that satisfies "buyers get confirmations", provable against the fake notification port without waiting for the kernel); then card, e-Transfer and balance checkout with payment completion, the sweeper, and refunds; then check-in and the guest list with the attendee projection; then the remaining organizer surfaces (sales, exports, messaging, co-hosts, invites, queue); then campaigns if D17 keeps them behind a flag; and finally the single page tree. The acceptance criteria become: every row marked KEEP or CHANGE in `03-mapping.md` works, the parity characterization suite passes, the api-spec is regenerated and accurate, and scoped tokens are adopted end to end. The #2515 acceptance line "work identically to the kernel version" is narrowed to the parity set plus the intentional-changes list in `02` section 9, so that fixing F01 and the other findings is not a regression.

### #2518 re-cut: identity, baseline adoption and deploy, starting with the template sync

Keep the three pillars and add two preconditions. First, run `scripts/sync-from-template.sh` so events has what the template added after the fork (the `/claim` route and page, `middleware.ts`, `docs/DEPLOY.md`, the registry-deps, migrations and audit checks and their workflows); this is a small PR into `rearchitect` and unblocks identity. Second, settle D12 (database topology), because the events#1 baseline migration targets an empty database and is explicitly not idempotent against the existing prod and dev `events` schema. Identity stays an operator step through the claim flow, separately for dev and prod, with no key material in logs. The migration baseline becomes a "refuse on mismatch, never drop" check modelled on the Dykil legacy baseline: it introspects the live `events` schema against the pinned expectation (8 tables, 126 columns, 26 indexes, 10 foreign keys, and the data invariants the new code relies on), prints counts only, and exits non-zero on any difference; additive migrations for the outbox, receipts, organizers and attendee tables are applied only after the baseline passes. Deploy follows the template convention (one pm2 entry and one Caddy route per environment, same ports) and the `.env.example` is rewritten to the shrunken contract in `02` section 11, with the six kernel-shared secrets gone.

### #2529 re-cut: dev cutover and soak against the parity set and the prod-shaped data

Keep the purpose and tighten the evidence. The sanitized prod-shaped copy must include the shapes `01-current-state.md` section 8 predicts: legacy tickets with no order, soft-DID owners, events with no private key, free-pattern signatures, held e-Transfer tickets past expiry, drifted `sold` counters, and tickets whose attendee answers live only in Dykil. Before the soak starts the operator records the counts listed in that section so results are comparable. The pass criteria are the parity set (ids, QR validity, URLs in both historical shapes, pricing and `.fair` snapshots, exports with the same columns) plus an explicit check of each intentional change, including that a paid unused ticket now passes the Dykil gate. "Existing tickets and QR codes keep validating" is proven by scanning tickets issued by the kernel version through the new check-in path, which works because ids are preserved. The rehearsed rollback must include the data side: because the app and the kernel share a Postgres server under D12, rollback is a re-point of pm2 and Caddy with no data movement, and the rehearsal must prove that the additive tables are ignored harmlessly by the kernel version. Rollback is not fully data-free, though: registrations taken while the new app was live exist as Dykil attestations and `ticket_attendees` rows, which the kernel version does not read, so the rehearsal must state exactly what is invisible after a rollback and how it is re-imported (this follows from D08). Zero open defects and Ryan's sign-off remain the exit conditions.

### #2516 re-cut: prod cutover only after the kernel gaps it needs are closed

Keep it prod-only and keep every gate Ryan set (the #2529 sign-off, an agreed window with no live or imminent event and no expected sales spike, a ready rollback, and post-cutover spot checks of a live event page, a real or comped purchase, and an existing ticket). Add one precondition that the design makes explicit: the kernel-side gaps for the four outcome verbs must be live in prod before the window, namely app-auth notification send (so confirmations flow), payment-completion delivery or status read, app-scoped refund rights, and the kernel chat access change (G03, G05, G16, G12 in `05-kernel-gaps.md`). Add a fifth spot check that a purchase produces a confirmation the buyer actually receives, because that is the verb a silent failure would hide. The kernel's own `apps/events` keeps running, unchanged and unmodified, until this step is signed off, so the old and new apps never both accept writes: the window switches the Caddy route and pm2 entry, and the old process is stopped, not deleted.

### #2517 re-cut: prune, ordered by the kernel dependencies, after prod is stable

Keep "prune last, blocked by #2516" and make the order explicit, because deleting `apps/events` first would break callers. In order: retire the kernel reactors, webhook and environment variables that call events (pay's `notifyEventsService`, the `settlement.completed` webhook, the bus chains and database chain rows for the 17 events types, the notify templates once they live in this repo); remove the kernel's reads of events tables in chat access and in `src/lib/kernel/access.ts`; re-point or drop the LLM presence tools, the chat title lookup, the onboard-verify call, and the nav and profile links; then remove `apps/events` and its entry in scripts and pm2 checks. On migrations, apply the existing rule of deciding per table in the PR: the eight `events` tables are not kernel-owned, so the kernel stops carrying migrations for them and the tables are never dropped by the kernel (the standalone app owns them); the thirteen kernel migration files that mention `events` stay in history. Acceptance adds a grep-level check that no kernel source references `events.` tables or `EVENTS_SERVICE_URL`, alongside "the kernel builds and deploys without it".

## 3. Order of work at a glance

1. Ratify the design (Ryan); resolve the decision cards that block building, in this order: D01, D12, D02, D03, D05, D04, D06, D07, D08, D09.
2. Kernel gaps filed and scheduled in parallel with the first build slices (they are not needed for the skeleton).
3. Build slices into `rearchitect` (#2515).
4. Template sync and identity and baseline (#2518), which can begin as soon as D12 is settled.
5. Dev cutover and soak (#2529).
6. Prod cutover window (#2516), with Ryan's sign-off.
7. Prune (#2517).
