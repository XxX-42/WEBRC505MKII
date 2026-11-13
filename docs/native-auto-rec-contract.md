# Native AUTO REC contract (software approximation)

## Scope and evidence

Native AUTO REC is a Native-host software approximation named `raw-peak-dbfs-v1`. It reuses the browser detector mapping: sensitivity 1..100 maps linearly to threshold -12..-60 dBFS; raw input peak at or above the threshold triggers recording. This is not a Roland measurement or a claim about Roland's undocumented threshold. Official evidence confirms only that recording starts after input is detected and the indicator flashes quickly; no official threshold or flash frequency is specified. Detection uses unprocessed raw input; no pre-roll is retained.

This first slice supports empty-track, immediate REC only. LOOP SYNC and measure quantization combinations are rejected as unsupported. Existing phrases cannot be overwritten by an AUTO REC arm.

## Settings API and state

`POST /v1/record/auto-rec` requires exactly one `X-Native-Host-Incarnation` header matching the current host and JSON `{ "enabled": boolean, "sensitivity": integer(1..100), "expectedRevision": safeInteger }`. It performs compare-and-swap against current settings revision and requires a running Native engine. Stale host/revision returns 409; malformed values return 400; a settings change while any track is armed or another track command/settings callback is pending returns 409. Requested values become applied only at an audio callback boundary; status equality of requested/applied revision is the settings ACK. Success returns status JSON including `nativeAutoRec`.

`nativeAutoRec` status is `{ available, detectorModel, settings: { enabled, sensitivity, requestedRevision, appliedRevision }, tracks: [{ trackId, armRequestedRevision, armAppliedRevision, triggerAppliedRevision, triggerContentRevision, cancelAppliedRevision, armed }] }`. `available` means this host implements the detector, not that physical input is currently present. Settings default to disabled / sensitivity 50, including older archives which omit these fields. Memory persists settings only; an armed state is never serialized.

## Arm, trigger, cancel

With settings enabled, arm through `POST /v1/transport/record/auto-rec?trackId=N` with one `X-Native-Host-Incarnation` header and JSON `{ "intentId": "<32 lowercase hex>", "expectedArmRevision": safeInteger }`. The expected revision is the current per-track `armRequestedRevision`; the accepted generation is expected + 1. Same intent plus same expected revision is idempotent: it returns the existing generation and current readback without arming again, even if that generation already triggered or was cancelled. A different intent while armed, or a stale revision, returns 409. The legacy `POST /v1/transport/record?trackId=N` returns 409 while AUTO REC is enabled and does not arm or cancel.

Cancel through `POST /v1/transport/record/auto-rec/cancel?trackId=N` with the same host header and JSON `{ "intentId": "<32 lowercase hex>", "armRevision": positiveSafeInteger }`. It only cancels that exact currently armed generation. Repeating the same cancel is idempotent; a trigger that already won the callback race is reported as triggered and cannot be relabelled cancelled. Either existing REC ACTION (REC->PLAY or REC->DUB) is supported, and normal existing finish behavior applies. Arm is accepted only on an Empty track with LOOP SYNC / REC QUANTIZE OFF. Its HTTP 200 response proves only that arm was accepted; it is not a recording ACK, must not create/confirm a recording tempo token, and must not imply captured audio. Non-empty tracks are rejected without modification. With settings disabled, existing REC behavior is unchanged.

The audio callback watches raw input samples. On the first sample whose absolute peak is greater than or equal to the configured threshold, the same callback begins writing at that sample offset; earlier samples in that callback are not written. The left and right channels are considered independently, and an armed track captures its input independently of other tracks. No callback allocation, lock, JSON work, or large PCM copy is allowed.

Only the actual threshold trigger may publish `triggerAppliedRevision` and the take start `triggerContentRevision` and the currently applied Native BPM plus native tempo revision. Tempo changes while armed are allowed; the token is sampled at the trigger callback, so it describes the take start. An absent applied tempo yields no valid token. The UI should consider AUTO REC recording confirmed only after status shows the track recording and a nonzero trigger-applied revision for the current arm generation; an arm ACK alone means waiting for input.

STOP, CLEAR, reset/reconfiguration cancel an armed generation using the same generation CAS as the detector; a late detector result from a cancelled generation must not start recording. While armed or resolving, Memory import/capture and REC ACTION, REC QUANTIZE, and LOOP SYNC edits are rejected. Memory replacement cannot serialize arm state. Existing phrase content is never replaced by arming.

To stop a confirmed AUTO REC take, use `POST /v1/transport/record/auto-rec/stop?trackId=N` with the host header and `{ "intentId", "armRevision", "expectedContentRevision", "stopIntentId" }`. Persist `stopIntentId` before POST. The host checks the same arm generation, trigger revision, `Recording` state, and equality of trigger, expected, and current content revisions before queueing, then repeats those checks at the callback application boundary. A mismatch publishes `rejectedRevision` and leaves the track PCM untouched. `nativeAutoRec.tracks[N].stopReceipt` retains the latest request fingerprint and requested/applied/rejected revisions for GET reconciliation; only `appliedRevision === requestedRevision` with `appliedContentRevision` published means STOP completed. The receipt is scoped to the current host incarnation. A repeated POST with the same stopIntentId and fingerprint is idempotent.

## Validation targets

Cover quiet input staying armed; exact-threshold PCM triggering at the exact sample offset; cancel-versus-trigger races; independent stereo track arming; CLEAR/reset/old-Memory cancellation; and zero callback allocations. Tests must distinguish arm acknowledgement from trigger acknowledgement.




