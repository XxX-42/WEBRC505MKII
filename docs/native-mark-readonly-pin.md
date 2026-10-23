# Native MARK copy continuity

MARK SET uses a read-only pin of finalized Playing/Stopped PCM. The callback latches and acknowledges that purpose before the control thread copies the loop. Playback, its cursor, per-track pitch processing and vocoder carrier reads continue during the copy. No PCM copy or allocation occurs on the callback.

The pin index stays active throughout the operation. Existing command, project-import and loop-transport writer guards remain closed. Recording/overdubbing cannot receive a read-only acknowledgement. Undo/redo explicitly requests the original exclusive purpose and continues to suppress reads while it exchanges PCM or restores metadata.

The regression test holds all three core mutexes on a concurrent copying thread and runs 32 callbacks per pin for three cases: exact dry PCM continuity, pitched-track continuity, and selected vocoder-carrier continuity. Every snapshot copy is byte-checked and each pinned playhead advances. A queued Stop remains deferred until release. Separate checks preserve exclusive-pin suppression and reject a read-only request during Recording. Existing real MARK and whole-Memory tests also pass. These are software tests, not hardware/audio-quality acceptance.
