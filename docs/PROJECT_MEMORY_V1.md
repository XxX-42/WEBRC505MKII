# Project Memory v1

Browser and Native runtimes can export and import this shared v1 archive and
save it into the same site-local IndexedDB 99-slot store. IndexedDB data stays
in this browser profile, and no project PCM is sent to a remote server.

## What v1 stores

- A project name and BPM
- Five ordered loop entries; each is empty (`null`) or mono/stereo Float32 PCM
- Per-loop sample rate, frame count, and channel count
- Master-track ID, master loop frame count, measure duration, and time signature
- A SHA-256 digest for each nonempty PCM region

FX parameters, FX assignments, rhythm kit, rhythm patterns/sections, and other
rhythm-engine settings are not included. Loading a project leaves those settings
alone while applying the saved BPM and transport metadata. Transport uses
quarter-note BPM and derives measure duration from both time-signature parts:
`(numerator × 4 ÷ denominator) × 60 ÷ BPM`.

## Binary archive layout

All integers and Float32 samples are little-endian:

1. Eight-byte `RC505PA\0` magic
2. A 32-bit manifest byte length
3. UTF-8 JSON manifest (metadata only; PCM is never base64)
4. Contiguous per-track Float32 PCM payloads in frame-major, interleaved channel order

The manifest declares format `rc505-project-archive`, version `1`, exact payload
offsets and lengths, and each PCM SHA-256. The decoder rejects unknown schema
fields, duplicate JSON keys, noncontiguous/trailing payloads, malformed hashes,
non-finite samples, bad lengths, invalid metadata, and unsupported versions before
any live track is changed.

## Bounds and restore behavior

- Exactly five track entries; each nonempty loop is 1–2 channels and at least one frame
- Sample rates: 8,000–384,000 Hz; BPM: 40–300
- Project name: at most 512 UTF-8 bytes
- Aggregate PCM payload: at most 768 MiB; manifest: at most 64 KiB
- Master track must refer to a nonempty loop, and its frame count and measure timing
  must agree with the manifest and BPM
- Browser restore prepares and validates all five AudioBuffers before a batch install.
  Every replaced loop is retained as that track's one-step PCM undo state, subject to
  the existing shared 512 MiB Browser history budget. Budget refusal leaves loops
  unchanged.
- Native import requires the audio engine to be running at the exact sample rate
  recorded in the archive; it does not resample. It validates and prepares all five
  full-capacity stereo candidate stores on the control thread, then swaps all five at
  one callback boundary. A successful import stops every loop, leaves playback stopped,
  and clears Native PCM undo/redo history; failures before callback commit preserve the
  existing loops, history, BPM, and FX state.
- Native import admission uses a 3 GiB transaction peak estimate covering existing
  loop storage, five full-capacity candidate stores, the encoded archive, decoded PCM,
  retained undo PCM, and a fixed process margin. This is an estimate of known allocations,
  not an operating-system RSS limit; large projects can be rejected before any loop changes.
- Before any Native upload, the app persists a random operation ID, operation-start content
  revision, host incarnation, and SHA-256 of the exact incoming archive beside the pre-import
  recovery snapshot. The host binds that ID to the same archive digest and revision in one
  serialized acceptance path. Repeating the same ID and fingerprint returns its original
  generation; changing either fingerprint field is rejected.
- Native status recovery queries by operation ID and requires an exact operation ID, host
  incarnation, archive digest, and operation-start revision match. A missing operation or
  evicted core status is not evidence of rejection or cancellation; the candidate stays
  unresolved, write actions remain blocked, and the UI still offers current-project and
  pre-import snapshot export. A pre-import snapshot can be restored only after exact committed
  status is verified, and it remains stored until that restore transaction commits.
- The Native operation ledger retains up to 256 accepted import operations per process incarnation.
  It does not discard terminal entries automatically: a client may still need an operation's
  receipt to resolve its durable recovery candidate, and reusing a forgotten ID could start a
  second import. At capacity, new IDs fail closed with a structured, user-visible error that
  reports the used/maximum count and explains the recovery boundary. Restarting changes host
  incarnation and permits new imports, but does not recover old operation status, resolve old
  recovery candidates, or prove which PCM is current; restarted-host PCM is never an old import
  receipt. Preserve unresolved candidates across that restart.
- Browser import currently uses a 4 GiB estimate for resident PCM, history, archive,
  decoded samples, and candidate AudioBuffers. This estimates those known PCM
  allocations; it is not a hard bound on browser/AudioContext heap overhead.
- A successful Browser load stops the loops, restores PCM/BPM/master timing, and does
  not resume playback automatically.

Memory slots 1–99 store metadata and binary archive payload in one IndexedDB
transaction. Replacing an occupied slot requires confirmation. Slot data is not a
cloud backup. Native export uses callback-pinned per-track snapshots and validates
each content revision before and after five-track capture to avoid saving mixed loop
generations.
