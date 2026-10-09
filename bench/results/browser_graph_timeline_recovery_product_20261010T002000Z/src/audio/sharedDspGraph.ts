import browserDspBuildPin from '../../shared/dsp/wasm/browser-build-pin.json';

export const BROWSER_SHARED_DSP_WASM_URL = '/dsp/webrc-dsp.wasm';
export const BROWSER_SHARED_DSP_BUILD_URL = '/dsp/webrc-dsp.build.json';

const EXPECTED_EMSDK_COMMIT = '35ff8a6d150541276abbc6bae512ca90bcfbe220';
const EXPECTED_COMPILER_ID = /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/;
const EXPECTED_SOURCE_FILES = [
  'shared/dsp/src/primitives.cpp',
  'shared/dsp/src/control_dynamics.cpp',
  'shared/dsp/src/nonlinear.cpp',
  'shared/dsp/src/fft.cpp',
  'shared/dsp/src/pitch.cpp',
  'shared/dsp/src/signalsmith_adapter.cpp',
  'shared/dsp/src/spatial_temporal.cpp',
  'shared/dsp/src/streaming_yin.cpp',
  'shared/dsp/src/live_mono_pitch.cpp',
  'shared/dsp/src/rhythm.cpp',
  'shared/dsp/src/cleanroom_rhythm_data.cpp',
  'shared/dsp/src/performance_fx.cpp',
  'shared/dsp/src/modulation_fx.cpp',
  'shared/dsp/src/fx_registry.cpp',
  'shared/dsp/wasm/handle_registry.cpp',
  'shared/dsp/wasm/webrc_dsp_wasm.cpp',
  'shared/dsp/wasm/webrc_dsp_extended.cpp',
  'shared/dsp/wasm/webrc_dsp_fx.cpp',
];
const WASI_IMPORTS = [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
] as const;

export type SharedDspRoute = 'recordInput' | 'trackLoopOutput' | 'monitor' | 'rhythm';
export type SharedDspFilter = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowShelf' | 'highShelf';

export interface SharedDspFilterRequest {
  route: SharedDspRoute;
  track?: number;
  filter: SharedDspFilter;
  values: number[];
}

export interface BrowserSharedDspArtifact {
  module: WebAssembly.Module;
  sha256: string;
  sourceSetSha256: string;
  byteLength: number;
  compilerIdentity: string;
}

export interface SharedDspRouteCapability {
  status: 'available' | 'existing-browser-path' | 'not-integrated';
  processor: string | null;
  boundary: string;
  detail: string;
}

export const BROWSER_SHARED_DSP_ROUTE_CAPABILITIES: Readonly<Record<string, SharedDspRouteCapability>> = Object.freeze({
  inputRecording: {
    status: 'available', processor: 'BiquadDf2T', boundary: 'routed per-track input → looper recording',
    detail: 'Preallocated stereo filters run inside the existing looper Worklet before record/overdub writes.',
  },
  trackPlayback: {
    status: 'available', processor: 'BiquadDf2T', boundary: 'looper playback → per-track FXChain',
    detail: 'Five independent stereo filters run in the existing Worklet after loop rendering.',
  },
  monitor: {
    status: 'available', processor: 'BiquadDf2T', boundary: 'monitor input → monitor output',
    detail: 'A preallocated stereo filter runs on the monitor output bus.',
  },
  rhythm: {
    status: 'available', processor: 'BiquadDf2T', boundary: 'rhythm synthesis → rhythm output/delay',
    detail: 'A preallocated stereo filter runs on the existing rhythm output bus.',
  },
  inputFxBank: {
    status: 'existing-browser-path', processor: null, boundary: 'input FX bank graph',
    detail: 'Current WebAudio FX graph remains active; no shared-DSP FX-bank mapping is published.',
  },
  trackFxBank: {
    status: 'existing-browser-path', processor: null, boundary: 'track send FX bank graph',
    detail: 'Current WebAudio FX graph remains active; no shared-DSP FX-bank mapping is published.',
  },
  masterOutput: {
    status: 'existing-browser-path', processor: null, boundary: 'output FX bank → master gain/destination',
    detail: 'Current WebAudio output path remains active; shared processing is not inserted after the mix.',
  },
  bounce: {
    status: 'not-integrated', processor: null, boundary: 'offline/realtime bounce render',
    detail: 'Project bounce does not yet invoke the shared-DSP graph.',
  },
});

type BuildManifest = {
  schemaVersion: number;
  artifact: { file: string; byteLength: number; sha256: string };
  build: { emsdkCommit: string; compilerIdentity: string };
  sourceFilesStableDuringBuild: boolean;
  sourceFiles: Record<string, string>;
  sourceSetSha256: string;
};

let artifactPromise: Promise<BrowserSharedDspArtifact> | null = null;

export function loadBrowserSharedDspArtifact(
  fetcher: typeof fetch = fetch,
  wasmUrl = BROWSER_SHARED_DSP_WASM_URL,
  buildUrl = BROWSER_SHARED_DSP_BUILD_URL,
): Promise<BrowserSharedDspArtifact> {
  if (!artifactPromise) {
    const pending = fetchAndCompile(fetcher, wasmUrl, buildUrl);
    artifactPromise = pending;
    void pending.catch(() => {
      if (artifactPromise === pending) artifactPromise = null;
    });
  }
  return artifactPromise;
}

async function fetchAndCompile(
  fetcher: typeof fetch,
  wasmUrl: string,
  buildUrl: string,
): Promise<BrowserSharedDspArtifact> {
  const [wasmResponse, buildResponse] = await Promise.all([fetcher(wasmUrl), fetcher(buildUrl)]);
  if (!wasmResponse.ok) throw new Error(`Shared DSP WebAssembly fetch failed (${wasmResponse.status}).`);
  if (!buildResponse.ok) throw new Error(`Shared DSP build manifest fetch failed (${buildResponse.status}).`);
  const [bytes, build] = await Promise.all([
    wasmResponse.arrayBuffer(), buildResponse.json() as Promise<BuildManifest>,
  ]);
  if (build.schemaVersion !== 1 || build.sourceFilesStableDuringBuild !== true ||
      build.build.emsdkCommit !== EXPECTED_EMSDK_COMMIT || !EXPECTED_COMPILER_ID.test(build.build.compilerIdentity) ||
      build.build.emsdkCommit !== browserDspBuildPin.build.emsdkCommit ||
      build.build.compilerIdentity !== browserDspBuildPin.build.compilerIdentity ||
      build.artifact.sha256 !== browserDspBuildPin.artifact.sha256 ||
      build.artifact.byteLength !== browserDspBuildPin.artifact.byteLength ||
      build.sourceSetSha256 !== browserDspBuildPin.sourceSetSha256 ||
      build.artifact.file !== BROWSER_SHARED_DSP_WASM_URL.slice(1)) {
    throw new Error('Shared DSP build manifest uses an unsupported or unpinned WebAssembly toolchain.');
  }
  for (const source of EXPECTED_SOURCE_FILES) {
    if (!/^[a-f0-9]{64}$/.test(build.sourceFiles?.[source] ?? '')) {
      throw new Error(`Shared DSP build manifest is missing its pinned source hash for ${source}.`);
    }
  }
  const sourceSet = Object.keys(build.sourceFiles).sort()
    .map((relative) => `${relative}=${build.sourceFiles[relative]}`).join('\n');
  const sourceSetDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceSet));
  const sourceSetSha256 = Array.from(new Uint8Array(sourceSetDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sourceSetSha256 !== build.sourceSetSha256) throw new Error('Shared DSP source-set hash is inconsistent.');
  if (!Number.isSafeInteger(build.artifact.byteLength) || build.artifact.byteLength !== bytes.byteLength) {
    throw new Error('Shared DSP WebAssembly byte length does not match its build manifest.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== build.artifact.sha256 || sha256 !== browserDspBuildPin.artifact.sha256) {
    throw new Error('Shared DSP WebAssembly hash does not match its pinned build manifest.');
  }
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module).map(({ module: name, name: symbol, kind }) => [name, symbol, kind]);
  if (JSON.stringify(imports) !== JSON.stringify(WASI_IMPORTS)) {
    throw new Error('Shared DSP WebAssembly has an unexpected import surface.');
  }
  return {
    module,
    sha256,
    sourceSetSha256: build.sourceSetSha256,
    byteLength: bytes.byteLength,
    compilerIdentity: build.build.compilerIdentity,
  };
}

export interface SharedDspReply {
  type: string;
  requestId?: number;
  ok?: boolean;
  message?: string;
  [key: string]: unknown;
}

type PendingReply = { resolve: (message: SharedDspReply) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> };

export class BrowserSharedDspGraph {
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingReply>();
  private ready = false;
  private readonly port: MessagePort;

  public constructor(port: MessagePort) {
    this.port = port;
  }

  public markReady(): void {
    this.ready = true;
  }

  public configureFilter(request: SharedDspFilterRequest): Promise<SharedDspReply> {
    this.validateFilterRequest(request);
    return this.request('SHARED_DSP_CONFIGURE_FILTER', { ...request });
  }

  public clearFilter(route: SharedDspRoute, track?: number): Promise<SharedDspReply> {
    if ((route === 'recordInput' || route === 'trackLoopOutput') && !isTrack(track)) {
      throw new RangeError('Per-track DSP routes require a zero-based track index from 0 through 4.');
    }
    if ((route === 'monitor' || route === 'rhythm') && track !== undefined) {
      throw new TypeError('Monitor and rhythm routes do not accept a track index.');
    }
    return this.request('SHARED_DSP_CLEAR_FILTER', { route, track });
  }

  public receive(message: SharedDspReply): void {
    if (message.type === 'SHARED_DSP_READY') this.ready = true;
    if (typeof message.requestId !== 'number') return;
    const pending = this.pending.get(message.requestId >>> 0);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId >>> 0);
    if (message.ok === true) pending.resolve(message);
    else pending.reject(new Error(message.message || 'Shared DSP Worklet rejected the request.'));
  }

  public dispose(): void {
    this.port.postMessage({ type: 'SHARED_DSP_DISPOSE' });
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Shared DSP graph disposed before request ${requestId} completed.`));
    }
    this.pending.clear();
    this.ready = false;
  }

  private request(type: string, data: Record<string, unknown>): Promise<SharedDspReply> {
    if (!this.ready) throw new Error('Shared DSP graph is not ready; no effect change was applied.');
    this.nextRequestId = (this.nextRequestId + 1) >>> 0 || 1;
    const requestId = this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Shared DSP Worklet did not acknowledge the request.'));
      }, 2_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.port.postMessage({ type, requestId, ...data });
    });
  }

  private validateFilterRequest(request: SharedDspFilterRequest): void {
    if (!['recordInput', 'trackLoopOutput', 'monitor', 'rhythm'].includes(request.route)) {
      throw new TypeError('Shared DSP route is unavailable.');
    }
    if ((request.route === 'recordInput' || request.route === 'trackLoopOutput') && !isTrack(request.track)) {
      throw new RangeError('Per-track DSP routes require a zero-based track index from 0 through 4.');
    }
    if ((request.route === 'monitor' || request.route === 'rhythm') && request.track !== undefined) {
      throw new TypeError('Monitor and rhythm routes do not accept a track index.');
    }
    if (!['lowpass', 'highpass', 'bandpass', 'peaking', 'lowShelf', 'highShelf'].includes(request.filter) ||
        !Array.isArray(request.values) || !request.values.every(Number.isFinite)) {
      throw new TypeError('Shared DSP filter parameters are malformed.');
    }
    const count = request.filter === 'peaking' || request.filter === 'lowShelf' || request.filter === 'highShelf' ? [3, 4] : [2, 3];
    if (!count.includes(request.values.length)) throw new RangeError('Shared DSP filter parameter count is invalid.');
  }
}

function isTrack(track: unknown): track is number {
  return Number.isInteger(track) && Number(track) >= 0 && Number(track) < 5;
}
