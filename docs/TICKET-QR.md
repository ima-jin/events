# Signed ticket QRs
Ticket QRs contain `ticket-v1.<base64url claims>.<HMAC-SHA256>`, not a raw ticket ID.
The MAC covers the version and claims. Claims bind `ticketId` and optionally
`expiresAt` (Unix seconds). Verification uses a constant-time MAC comparison,
requires the route's exact ticket ID, and rejects expiry at or before the current second.
Tokens are bearer credentials: do not log, share publicly or cache them.

## Deployment and migration
The registered-app manifest declares the QR HMAC recipe. The kernel issues and seals it
on provision/claim; the published app-keystore vault loader fetches it only into memory
before events becomes ready. For an existing registration, use **Sync manifest secrets**
on `/jin` and countersign, then restart. No env credential or env fallback exists.
QR issuance fails closed before vault loading completes. All instances using the same
app DID fetch that app's current generation.

**Old raw-ID QRs are rejected, with no organizer override.** Before deployment,
notify organizers and holders: holders sign in and load their ticket QR again,
or organizers resend ticket emails (the existing resend cooldown still applies).
All email issuance paths now use the same signed format. Updating the check-in
client to submit the scanned token is required in the same deployment window.
There is no database migration. Rotating the secret invalidates all existing
tokens after restart; reissue QRs through the same holder/email paths after rotation.
Use **Rotate** on `/jin`, countersign, then restart through the operator's deployment tool;
no file edit, credential reveal or copying step is needed.

Default emailed/API tokens have no expiry, to support saved and printed tickets.
The signing helper accepts an optional expiry for bounded-lifetime issuance.
Check-in still reads current ticket status and event membership from the database;
cancelled, refunded and already-used tickets remain invalid.

## API contract
`GET /api/tickets/:id/qr` requires an authenticated session or scoped app token.
Only the current holder's resolved DID (including verified act-as/delegation)
matches; a non-holder or unknown ticket returns 404. Successful responses are
`private, no-store`. Public registration completion no longer returns a QR;
the signed QR is delivered in its existing email and via the holder-only route.

Organizers submit `POST /api/events/:id/tickets/:ticketId/check-in` with JSON
`{"token":"<scanned ticket-v1 token>"}`. Decode the token's claims only to choose
the ticket route; never trust that decoding as verification. The server verifies
the MAC and exact ticket binding before reading or updating the ticket. Missing,
forged, wrong-ticket, expired or raw-ID payloads return 400. Organizer
authorization is still required; possessing a token alone cannot check in a ticket.

## Production copy
The standalone cutover issues ima-jin/imajin-ai#2516, #2529 and #2784 were still
open when this fix was prepared. Repository documentation says kernel deployment
configs still own monorepo events entries. This PR changes only `ima-jin/events`;
it does not prove a production cutover or secure an old kernel checkout. Coordinate
the production copy's matching security rollout before claiming production protection.
