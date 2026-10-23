# Browser AutoRec provider

Official source: RC-505mkII Parameter Guide v1.3 p.4, Memory Settings (LOOP), REC / AUTO REC.
https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf

SW ON arms on REC/PLAY; input crossing SENS starts capture. SENS is integer 1..100, default 50. Official docs do not specify threshold dBFS calibration, detection window or pre-record duration. This provider explicitly approximates them: raw stereo sample peak, SENS 1..100 mapped from -12 to -60 dBFS, no added pre-trigger PCM. It does not claim calibrated hardware parity.

The shared input capture worklet owns the arm and trigger. It captures the crossing sample through the existing per-track raw/processed capture gate. RECORD_CONFIGURED is the renderer trigger acknowledgement; the host never polls meters to decide the trigger. Existing preallocated slot/message/chunk pools are reused; the per-sample trigger path has no new allocation, lock or blocking operation.

Provider API: getBrowserAutoRecSettings()/setBrowserAutoRecSettings({enabled, sensitivity}); TrackAudio.autoRecArmed exposes the pending arm. Shared beginInputCaptureSession accepts an optional fifth linear threshold argument. Its startFrame getter changes from the arm request frame to the actual renderer trigger frame after the matching generation/session CONFIGURED acknowledgement.

Stop, second REC/PLAY, clear, input loss, or a settings change cancel an arm. Cancellation never publishes a partial/silent take. Existing loop PCM remains intact except an explicit user clear. Shared capture must already be ready: AutoRec never falls back to the immediate legacy recorder. With an existing master and QUANTIZE MEASURE, AutoRec refuses to arm and reports that QUANTIZE OFF is required because the combined hardware timing rule is undocumented. Semantic Memory capture/replacement is refused while armed; after cancellation normal transactional replacement applies.

Authored settings are included in Browser semantic Memory as autoRec and supported fields record.autoRecSw / record.autoRecSens. Legacy envelopes without this extension restore disabled/50. Publication and rollback restore settings along with the existing PCM/configuration fence. Native support is not added.

Focused synthetic unit evidence: input capture worklet 19 tests, setting validation 2 tests, track lifecycle 11 tests, Browser semantic Memory 17 tests. These validate software contracts, not real-device timing or hardware calibration. Facade/editor integration and final full gates belong to root integration.
