"""Stream Chrome trace events and measure graph scopes without summing children.

Only complete X slices are timed. Missing frames or trace loss fail closed.
This reports sampled trace windows, never hardware E2E latency or driver XRUNs.
"""
import argparse
import bisect
import codecs
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import re

GRAPH = "RealtimeAudioDestinationHandler::Render"
REQUEST = "AudioDestination::RequestRender"
WORKLET = "AudioWorkletProcessor::Process"


def stream_events(path, metadata):
    """Bound memory independently of the trace's total number of events."""
    digest = hashlib.sha256()
    decoder = codecs.getincrementaldecoder("utf-8")()
    parser = json.JSONDecoder()
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as source:
        buffer = ""
        eof = False

        def more():
            nonlocal buffer, eof
            raw = source.read(65536)
            digest.update(raw)
            eof = not raw
            buffer += decoder.decode(raw, final=eof)

        marker = None
        while marker is None:
            more()
            marker = re.search(r'"(?:events|traceEvents)"\s*:\s*\[', buffer)
            if eof or len(buffer) > 1048576:
                if marker is None:
                    raise ValueError("Trace events array missing from bounded header")
        # Capture metadata preceding the array. These evidence files place the
        # array last; trailing metadata is explicitly rejected below.
        metadata.update(json.loads(buffer[:marker.end() - 1] + "[]}"))
        metadata.pop("events", None)
        metadata.pop("traceEvents", None)
        buffer = buffer[marker.end():]
        need_separator = False
        while True:
            buffer = buffer.lstrip()
            if not buffer:
                if eof:
                    raise ValueError("Truncated trace array")
                more()
                continue
            if buffer.startswith("]"):
                tail = buffer[1:]
                buffer = ""
                while not eof:
                    more()
                    tail += buffer
                    buffer = ""
                if tail.strip() != "}":
                    raise ValueError("Unsupported trailing fields or corrupt trace JSON")
                break
            if need_separator:
                if buffer[0] != ",":
                    raise ValueError("Missing trace event separator")
                buffer = buffer[1:].lstrip()
                need_separator = False
            try:
                event, end = parser.raw_decode(buffer)
            except json.JSONDecodeError:
                if eof:
                    raise ValueError("Truncated or invalid trace event")
                more()
                continue
            if not isinstance(event, dict):
                raise ValueError("Trace event must be an object")
            buffer = buffer[end:]
            need_separator = True
            yield event
    metadata["uncompressedSha256"] = digest.hexdigest()


def quantiles(values):
    values = sorted(values)
    def at(p):
        return values[max(0, math.ceil(p * len(values)) - 1)] if values else None
    return {"count": len(values), "p50": at(.5), "p95": at(.95),
            "p99": at(.99), "p999": at(.999), "max": at(1)}


def analyze(path, sample_rate, device_sample_rate=None):
    metadata = {}
    slices = {GRAPH: [], REQUEST: [], WORKLET: []}
    phases = collections.Counter()
    gc = []
    count = 0
    for event in stream_events(path, metadata):
        count += 1
        name = event.get("name", "")
        phase = event.get("ph")
        if name in slices:
            phases[(name, phase)] += 1
        valid_slice = (phase == "X" and isinstance(event.get("ts"), (int, float))
                       and isinstance(event.get("dur"), (int, float))
                       and math.isfinite(event["ts"]) and math.isfinite(event["dur"])
                       and event["dur"] >= 0)
        if valid_slice and name in slices:
            slices[name].append(event)
        if valid_slice and (name.startswith("V8.GC") or "v8.gc" in event.get("cat", "")):
            gc.append(event)
    threads = {(event.get("pid"), event.get("tid")) for event in slices[WORKLET]}
    graphs = [event for event in slices[GRAPH] if (event.get("pid"), event.get("tid")) in threads]
    requests = [event for event in slices[REQUEST] if (event.get("pid"), event.get("tid")) in threads]
    intervals = collections.defaultdict(list)
    for event in graphs:
        intervals[(event.get("pid"), event.get("tid"))].append(event)
    for events in intervals.values():
        events.sort(key=lambda event: event["ts"])
    starts = {thread: [event["ts"] for event in events] for thread, events in intervals.items()}
    child_counts = collections.Counter()
    unmatched = 0
    for event in slices[WORKLET]:
        thread = (event.get("pid"), event.get("tid"))
        index = bisect.bisect_right(starts.get(thread, []), event["ts"]) - 1
        if index >= 0:
            parent = intervals[thread][index]
            if event["ts"] + event["dur"] <= parent["ts"] + parent["dur"]:
                child_counts[(thread, index)] += 1
                continue
        unmatched += 1
    def scope(events, frame_key, rate):
        groups = collections.defaultdict(list)
        invalid = 0
        for event in events:
            frames = event.get("args", {}).get(frame_key)
            if not isinstance(frames, int) or isinstance(frames, bool) or frames <= 0:
                invalid += 1
                continue
            groups[frames].append(event["dur"])
        return {"durationUnit": "microseconds", "unusableFrameMetadata": invalid,
                "byActualFrames": {str(frames): {
                    **quantiles(values), "deadlineUs": frames * 1e6 / rate if rate else None,
                    "overDeadline": sum(value > frames * 1e6 / rate for value in values) if rate else None,
                    "over60Percent": sum(value > .6 * frames * 1e6 / rate for value in values) if rate else None,
                    "over80Percent": sum(value > .8 * frames * 1e6 / rate for value in values) if rate else None,
                } for frames, values in sorted(groups.items())}}
    completion = metadata.get("traceCompletion") or {}
    data_loss = completion.get("dataLossOccurred")
    return {"schemaVersion": 1, "trace": str(path), "sampleRateHz": sample_rate,
            "eventCount": count, "metadata": metadata,
            "audioThreads": [list(thread) for thread in sorted(threads)],
            "graphRender": scope(graphs, "frames", sample_rate),
            # FIFO request frames belong to the device rate, which can differ
            # from the AudioContext rate when Chromium resamples the graph.
            "renderRequest": scope(requests, "frames_to_render", device_sample_rate),
            "deviceSampleRateHz": device_sample_rate,
            "worklet": quantiles([event["dur"] for event in slices[WORKLET]]),
            "workletsNotContainedInCompleteGraphSlice": unmatched,
            "workletChildrenPerGraph": dict(sorted(collections.Counter(
                child_counts.get((thread, index), 0) for thread, events in intervals.items()
                for index in range(len(events))).items())),
            "audioThreadGcCompleteSlices": quantiles([event["dur"] for event in gc
                if (event.get("pid"), event.get("tid")) in threads]),
            "phaseCounts": [{"name": name, "phase": phase, "count": value}
                for (name, phase), value in sorted(phases.items())],
            "traceDataLossOccurred": data_loss,
            "qualification": "not-passed",
            "limitations": ["Captured windows only; not a continuous 30-minute timing distribution.",
                "Wall-clock slices include scheduling and tracing overhead; not CPU-only timing.",
                "Graph render and request scopes are separate; never sum nested child durations.",
                "Request deadlines require independently measured device sample rate; context rate is insufficient.",
                "No hardware E2E latency or driver XRUN measurement.",
                "Complete slices are measured; incomplete B/E boundary slices are not fabricated.",
                "Trace loss must be explicitly false and continuity validated independently."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--sample-rate", type=float, required=True)
    parser.add_argument("--device-sample-rate", type=float)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not math.isfinite(args.sample_rate) or args.sample_rate <= 0:
        parser.error("sample-rate must be finite and positive")
    if args.device_sample_rate is not None and (
        not math.isfinite(args.device_sample_rate) or args.device_sample_rate <= 0):
        parser.error("device-sample-rate must be finite and positive")
    result = analyze(args.trace, args.sample_rate, args.device_sample_rate)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as target:
        json.dump(result, target, indent=2, ensure_ascii=False, allow_nan=False)
        target.write("\n")
    print(json.dumps({"output": str(args.output), "graphRender": result["graphRender"],
                      "unmatchedWorklets": result["workletsNotContainedInCompleteGraphSlice"]}))
