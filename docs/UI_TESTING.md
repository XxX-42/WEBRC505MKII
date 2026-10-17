# UI runtime checks

## Start the real Browser and Native runtimes

From the repository root on Windows, run:

```powershell
npm run dev:all
```

The launcher runs `npm ci` only when `node_modules` is missing. It locates an installed x64 MSVC toolchain and that installation's Ninja, then builds `native_bridge_host` in Release mode with WASAPI enabled, ASIO off, the no-audio simulation off, portable-tests-only off, and Native HQ export off. It starts the regular Native host and Vite hidden, waits for their health checks, and prints the URLs it actually selected. It prefers port 5173 and falls back to 4173; port 4174 remains reserved for Playwright. Existing listeners are reused only when they identify as this app's UI or a healthy regular Native host. Other listeners are left untouched.

If the regular Native executable is already built, use `npm run dev:all -- -SkipBuild`. If a healthy regular host already owns port 17755, the launcher reuses it and skips rebuilding the host. Logs and PID files are stored under `%LOCALAPPDATA%\WebRC505MKII\26_27_WebRC\dev-all`.

Open the printed Browser URL (`http://127.0.0.1:<port>/?audio=browser`) and Native URL (`http://127.0.0.1:<port>/?audio=native`) separately. The Browser page waits for **START AUDIO** because audio-context resume and microphone permission need a user gesture. Allow microphone access to test input capture. Output readiness is separate: if permission is denied, output can remain ready while the status reports input not connected; **CONNECT INPUT** retries the request. Resume waits are bounded to 15 seconds and microphone access waits to 20 seconds.

The Native page initializes against `http://127.0.0.1:17755/health` on load. The launcher builds and runs the regular WASAPI host, not `native_bridge_host_simulation.exe`; the simulation target is a test-only no-audio adapter and does not qualify as Native runtime acceptance. Choose usable input/output devices in Audio Settings if the system defaults are unsuitable. This launcher disables Native HQ export, so that capability should be shown as unavailable.

## Manual acceptance

In each runtime, exercise the visible transport and track controls: record a short phrase, stop, play it back, adjust levels, and clear the track. Confirm settings and the Browser/Native mode switch respond. In Native mode, confirm that the connected device is the real WASAPI device and that audio is captured and heard. When a control is unsupported by the selected runtime, confirm it is disabled and explains why instead of silently doing nothing. A successful bridge health response alone is not proof of audio capture or playback.

For Browser mode, separately confirm both output and microphone input. Check the displayed input status after granting permission, then reload with permission denied or revoked and verify that the user can retry input connection. Use a physical loopback or headphones to avoid acoustic feedback during live monitoring.

The bridge health check can be queried directly:

```powershell
Invoke-RestMethod http://127.0.0.1:17755/health
```

If the launcher reports startup failure, inspect its stdout/stderr logs in the runtime directory above. These checks establish functional software/device behavior for the tested machine; they are not latency benchmarks or Roland hardware-fidelity measurements.

## Replica controls

The Classic faceplate is the default for a new session. Its physical controls are real DOM buttons/sliders; the faceplate toolbar provides fit, zoom and scrolling. The Settings menu outside the device retains the Tech interface without restarting the audio engine.

Main faceplate labels and button text use 12 px or larger, with 11 px reserved for compact LCD secondary fields. Initial/FIT zoom stops at 80% to keep the controls readable; use the internal scrollbars/pan buttons on smaller windows, or choose a smaller manual zoom when needed. Active keys light their complete caps in their state color. A selected but bypassed FX slot has an outline instead of the enabled glow.

- **TRACK / LOOP** selects a track and opens its pages inside the central LCD. Track level, KeepPitch and WAV controls use the existing track controller. Unsupported actions explain their disabled state.
- Each track's **FX** key selects that track's real independent FX chain and opens its editor. The top **TRACK FX** bank and screen controls then follow this target; the editor's target selector can return to the shared post-mix bank. Shared-bank per-track apply switches are disabled because the engines do not expose that routing operation.
- **FX A–D / EDIT** selects and toggles the exact Input or Track bank slot and opens its detailed editor. Native Track bank editing also exposes the bridge's target selector. Native effect type replacement is saved until **MENU → Restart Native / Apply FX**; the app confirms before restarting if loops are present.
- **MENU / RHYTHM EDIT** opens the corresponding central LCD pages. The physical faceplate does not open floating editors or drawers. Up to four fields appear at a time; the four screen knobs address those fields. The fields also support mouse, touch and keyboard input. PAGE changes subpages within the current category, ENTER executes the selected command, and EXIT/Escape returns. Command fields use their LCD button/ENTER rather than a nonfunctional value knob. Confirmation also stays inside the LCD.
- **STOP** stops normally; holding it for 1500 ms clears the track. Pointer cancellation, loss of pointer capture and keyboard focus cancellation stop the clear timer.
- **UNDO/REDO** stays disabled because neither engine exposes the required history API. Native output gain, individual track gain and reverse stay disabled when the host does not expose them.

The Browser recorder in this baseline stores mono loops. This UI integration does not add stereo recording DSP. Native reports its separate channel capability through bridge status. Browser automated capture uses Chromium's virtual microphone with the real AudioContext and AudioWorklets; it does not measure physical audio latency.
