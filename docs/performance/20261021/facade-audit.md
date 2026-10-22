# Track facade call audit

On merged baseline dd7dbea, AudioEngine.recordTrack/stopTrack/playTrack/toggleOverdub/clearTrack route Browser calls to tracks[0]. Source search found no production UI caller of these legacy facade methods. TrackStrip uses its own trackAudio and NativeTrackProxy supplies explicit trackId to NativeAudioEngine. This is retained as compatibility debt, not rewritten without a real caller. Tests and performance matrices must still exercise all five track objects, not this facade shortcut.
