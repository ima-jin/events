# events re-architecture design

Step 0 of ima-jin/imajin-ai#1988 (`rebuild(events)`), tracked in ima-jin/imajin-ai#2716. This directory is docs only. It lands on the `rearchitect` branch of `ima-jin/events` and nothing in it merges to `main`, deploys, or prunes anything from the kernel until Ryan ratifies the design and signs off the prod cutover.

## The outcome this design serves

An organizer can create an event, sell tickets, have buyers get their confirmations, and check people in, through the standalone `ima-jin/events` app, re-architected, without events code, tables or one-off kernel endpoints living in the kernel.

## Documents

- `01-current-state.md` - the map of what exists today: every route (R01-R66), table (T1-T8), kernel call out of events (K01-K16), call into events (I01-I10), prod data shape at count level taken from code, defects found (F01-F16), and what events#1 and events#2 hold.
- `02-proposed-architecture.md` - the re-architected shape: ownership, ports, data model additions, flows for the four outcome verbs, and what must stay identical.
- `03-mapping.md` - old to new mapping for every route, table and kernel call.
- `04-parity-verdict-and-recut.md` - the explicit statement on events#2, and the re-cut proposals for #2515, #2518, #2529, #2516 and #2517.
- `05-kernel-gaps.md` - every `gap(kernel)` found, as a list to be filed against the kernel repo.
- `06-decisions.md` - the open design questions as `DECISION` cards.

## Verdict on events#2 (kernel parity port)

Superseded as the base. It stays a draft, is not merged, and serves as a read-only quarry for domain logic and behavioural tests that get re-homed behind the ports in `02-proposed-architecture.md`. The reasoning is in `04-parity-verdict-and-recut.md`; the short version is that a parity port cannot deliver the outcome (it sends no buyer confirmations, ships no UI, fails open on organizer checks) and its CI is red. This is a recommendation; it becomes binding when Ryan ratifies the design.

## Headline conclusions

- The kernel owns the delivery of buyer confirmations today, as a side effect of bus events that only an in-process import can publish. That is the single biggest blocker, and it is a kernel gap, not an events task.
- Money settlement is started by events asserting a split in the buyer's name. The design moves that authority to pay.
- Five kernel code paths call into events, two read events tables directly, and Dykil depends on a boolean ticket gate that currently counts a status no code writes. All of these must be closed before the kernel prune, in an order given in `04`.
- Ticket `signature` values are written but never verified, and event private keys sit in the database. The design makes custody and verification an explicit decision.
- The registered-app contract is the boundary: published `@ima-jin/*` SDK only, no cross-schema SQL, no in-process bus, no kernel secrets beyond the app's own registration credentials.

## Method and limits

Everything comes from code, migrations, CI logs and the public npm registry. No prod, dev or server access was used and no secrets were read. Row counts for prod do not appear in code, so none are stated; `01-current-state.md` section 8 lists the counts the operator must capture during the #2529 sanitization step. Guard findings come from identifiers in route files and can miss a check done in a helper, so they are marked as such where it matters.

## Naming and wording

Following the app's own rules, the kernel is described as the authoritative index and projection of users' signed records, not as the owner of truth. Signed records prove that a claim is consistent and attributed, not that it is true about the physical world; nothing here claims otherwise.
