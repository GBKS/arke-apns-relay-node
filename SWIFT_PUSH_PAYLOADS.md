# Mailbox push payloads

What the relay sends to APNs for each mailbox message type, i.e. what the app finds in `userInfo`. All of them have `type`. Every mailbox push (all but `mailbox_auth_refresh`) has `checkpoint` (decimal **string**: the uint64 does not fit a JSON number exactly) and `mailbox_id` (hex). To get anything the push leaves out, read the mailbox from `checkpoint`.

| `type` | Kind | Payload fields | Alert |
|---|---|---|---|
| `mailbox_arkoor` | alert | `checkpoint`, `vtxo_count`, `mailbox_id` | "Received ₿X" (or "Received bitcoin" if amounts couldn't be decoded) / "View payment." or "View N payments." |
| `mailbox_incoming_lightning_payment` | alert | `checkpoint`, `has_payment_hash`, `amount_sat`, `mailbox_id` | "Receiving ₿X" (or "Incoming payment") / "Open Arké to accept it." |
| `mailbox_lightning_send_finished` | alert | `checkpoint`, `success`, `payment_hash`*, `mailbox_id` | "Payment sent" / "Your Lightning payment completed." or "Payment failed" / "Your Lightning payment did not go through." |
| `mailbox_round_participation_completed` | silent | `checkpoint`, `payment_hash_count`, `mailbox_id` | — |
| `mailbox_recovery_vtxo_ids` | silent | `checkpoint`, `recovery_vtxo_count`, `mailbox_id` | — |
| `mailbox_auth_refresh` | silent | `mailbox_id`, `authorization_expires_at` | — (see [SWIFT_AUTH_WAKE_SPEC.md](SWIFT_AUTH_WAKE_SPEC.md)) |

\* `payment_hash` (added 2026-11): the Lightning payment hash as 64 lowercase hex characters, present for both successful and failed sends. Use it to find the send this push is about. It is **left out** when the Ark server's message carried no hash, so treat it as optional and fall back to refreshing pending sends.

Alert pushes don't set `content-available` or `mutable-content`, so the app only sees them when the user taps or the app is in the foreground.

## Privacy

`payment_hash` is the only payment identifier the relay passes to Apple. It is not secret (it is in the invoice and proves nothing without the preimage, which the relay never forwards), but it lets Apple link a specific Lightning payment to a device token. No VTXO IDs, preimages or unlock hashes are included in any push.
