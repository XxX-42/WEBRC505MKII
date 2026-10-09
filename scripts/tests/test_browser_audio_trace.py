import importlib.util
import gzip
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "analyze-browser-audio-trace.py"
SPEC = importlib.util.spec_from_file_location("audio_trace", SCRIPT)
TRACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRACE)


def event(name, ts, duration, pid=1, tid=7, **args):
    return {"name": name, "ph": "X", "pid": pid, "tid": tid,
            "ts": ts, "dur": duration, "args": args}


class AudioTraceMeasurementTests(unittest.TestCase):
    def analyze(self, events, **kwargs):
        with tempfile.TemporaryDirectory() as temporary:
            trace = Path(temporary) / "trace.json.gz"
            with gzip.open(trace, "wt", encoding="utf-8") as target:
                json.dump({"traceCompletion": {"dataLossOccurred": False}, "events": events}, target)
            return TRACE.analyze(trace, 48000, **kwargs)

    def test_parent_scope_not_child_sum_and_pid_isolation(self):
        result = self.analyze([
            event(TRACE.GRAPH, 0, 1000, frames=64),
            event(TRACE.WORKLET, 10, 600), event(TRACE.WORKLET, 700, 200),
            event(TRACE.GRAPH, 2000, 3000, frames=128),
            event(TRACE.WORKLET, 2100, 100),
            # Same TID in another process must not become this graph's data.
            event(TRACE.GRAPH, 0, 99999, pid=2, frames=64),
        ])
        groups = result["graphRender"]["byActualFrames"]
        self.assertEqual(groups["64"]["p99"], 1000)
        self.assertEqual(groups["128"]["overDeadline"], 1)
        self.assertEqual(groups["64"]["count"], 1)
        self.assertEqual(result["workletsNotContainedInCompleteGraphSlice"], 0)
        self.assertEqual(result["workletChildrenPerGraph"], {1: 1, 2: 1})

    def test_request_device_rate_is_independent_and_unknown_fails_closed(self):
        events = [event(TRACE.GRAPH, 0, 200, frames=128),
                  event(TRACE.WORKLET, 10, 50),
                  event(TRACE.REQUEST, 0, 9500, frames_to_render=441)]
        unknown = self.analyze(events)["renderRequest"]["byActualFrames"]["441"]
        self.assertIsNone(unknown["deadlineUs"])
        self.assertIsNone(unknown["overDeadline"])
        known = self.analyze(events, device_sample_rate=44100)
        self.assertEqual(known["renderRequest"]["byActualFrames"]["441"]["deadlineUs"], 10000)
        self.assertEqual(known["renderRequest"]["byActualFrames"]["441"]["overDeadline"], 0)

    def test_chunk_boundary_missing_frames_and_uncontained_worklet(self):
        # A Unicode payload crosses the streaming parser's 64 KiB boundary.
        events = [{"name": "metadata", "args": {"text": "音" * 70000}},
                  event(TRACE.GRAPH, 0, 100), event(TRACE.WORKLET, 300, 1)]
        result = self.analyze(events)
        self.assertEqual(result["eventCount"], 3)
        self.assertEqual(result["graphRender"]["unusableFrameMetadata"], 1)
        self.assertEqual(result["graphRender"]["byActualFrames"], {})
        self.assertEqual(result["workletsNotContainedInCompleteGraphSlice"], 1)
        self.assertEqual(result["qualification"], "not-passed")


if __name__ == "__main__":
    unittest.main()
