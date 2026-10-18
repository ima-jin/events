# Kernel gaps (refs ima-jin/imajin-ai#2515, #1988)

events talks to the kernel **only** through the registered-app contract: scoped app tokens, the published
`@ima-jin/*` SDK and the public kernel HTTP API (see `AGENTS.md` §2). The kernel version of these routes reached
into kernel internals (shared DB schemas, an in-process bus, shared service keys, session-only helpers). Where the
public contract has no equivalent yet, the port **fails closed or degrades to a logged no-op** instead of reaching
around the boundary, and the gap is recorded here. Each is a `gap(kernel)` marker in the code.

| Area | Where | Today | What the kernel needs to expose |
|------|-------|-------|---------------------------------|
| Eligibility evaluation after check-in | `src/lib/kernel.ts` `evaluateEligibility` | Best-effort; the kernel may refuse a third-party caller. | App-auth access to `POST /auth/api/eligibility/evaluate`. |
| Act-as / delegation (forest scope) | `src/lib/auth.ts` `resolveActingDid` | Always the caller's own DID. | Delegation overlay in the app-token contract. |
| Chat sync (member add/migrate, name policy) | `src/lib/event-update-helpers.ts`, webhook, cohosts, event routes | Calls the chat service with this app's `X-App-DID` / `X-App-Authorization`; no kernel-internal shared key. May be refused. | App-auth chat endpoints for registered apps. |
| Attendee event chat UI | `src/components/chat/event-chat.tsx` | Explicit unavailable accordion and disabled composer; no private messages fetched. | [imajin-ai#2785](https://github.com/ima-jin/imajin-ai/issues/2785): registered-app user-authorized access/read/send, name policy, and realtime/media capabilities (refs #1988). Current chat messages use legacy auth; access requires a kernel session cookie. |
| Event attribution editor ([#2787](https://github.com/ima-jin/imajin-ai/issues/2787)) | `src/components/organizer-form/fair-manifest.ts` | Published `.fair` document editor/validator rejects fee-only event manifests. They remain unchanged; supported document manifests are editable. | A published editor/validator or lossless public update contract for event fee manifests. |

Settlement, refunds and campaign charge-pledges use events' **own app-service token** and are
not shared-key gaps — see `src/lib/pay-settle.ts` and `src/lib/pay-app-request.ts`.
The operator must approve `pay:settle`, `pay:refund` and `pay:charge-pledges` for events'
app DID on `apps:service-scopes`. Deploy kernel PR imajin-ai#2786 first; its refund and
charge routes enforce app ownership as well as scope. Setup/confirm migration is events#27.

Kernel PRs imajin-ai#2910, #2911, #2913 and #2914 supply the scoped onboarding,
pod membership, order-payment enrichment and profile/contact contracts consumed in events#70.
These helpers use the existing app-service JWT, not registration headers or forwarded cookies.
Operator approval and owner/person consent prerequisites are in [REGISTRATION.md](./REGISTRATION.md#scoped-kernel-reads-and-private-onboarding).
Refusal or missing scope remains fail-closed; payment metadata is descriptive, not payment proof.

Private onboarding delivery is deliberately limited to confirmed app-bound hosted checkouts
with a stored `kernelTransactionId`. The kernel sends the separate magic-link email; events
never receives a verification credential. Free RSVP, EMT, legacy/unbound orders and unsupported
resources keep ordinary ticket/registration CTAs without a fabricated transaction reference.
Those limitations are intentional in imajin-ai#2910, not a token-minting gap.
Kernel PR #2912 remains held: no chat conversation metadata is wired here.

Domain notifications now use the shipped `POST /api/events` with an app-service token by
default, without a path override. See [README.md](../README.md#domain-events-notify-and-audit-only).
The kernel reserves `order.*`, so `order.refunded` still receives a non-fatal, error-logged 403;
it cannot be declared for approval without invalidating the entire provision preview.
Issue events#58 records the required kernel-policy/namespace decision. `settlement.*` is
also kernel-owned and is not sent through the app-domain publisher. This channel never
issues attestations, moves money, or invokes the settlement callback.
