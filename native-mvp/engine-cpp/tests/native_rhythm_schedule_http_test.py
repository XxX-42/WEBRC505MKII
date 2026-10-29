"""Rhythm-frame REC/STOP HTTP contract against the no-hardware host."""
import os
os.environ['WEBRC_NATIVE_BRIDGE_PORT'] = '17763'
import subprocess
import sys
import time
from native_bridge_http_simulation_test import request, require


def until(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        code, latest = request('/v1/status')
        require(code == 200, latest)
        if predicate(latest):
            return latest
        time.sleep(.005)
    raise AssertionError(('Native Rhythm schedule callback ACK timed out', latest))


def phase(status):
    value = status['nativeRhythm']['phase']
    require(value['available'] is True and value['snapshotStable'] is True, value)
    require(value['frameSchedulingAvailable'] is False, value)
    require(value['nextMeasureFrame'] > value['sampleFrame'], value)
    return {'trackId': 2, 'action': 'record', 'absoluteFrame': value['nextMeasureFrame'],
        'phaseEpoch': value['epoch'], 'settingsRevision': status['nativeRhythm']['tempoAppliedRevision']}


def phase_has_headroom(status):
    value = status['nativeRhythm']['phase']
    return value['available'] is True and value['snapshotStable'] is True and \
        value['nextMeasureFrame'] - value['sampleFrame'] > 24000


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)

        code, initial = request('/v1/status')
        require(code == 200, initial)
        # A frame scheduler endpoint is not equivalent to the complete user
        # feature. REC QUANTIZE stays unavailable until all mode semantics land.
        require(initial['nativeRecordPlay']['quantizeAvailable'] is False, initial)
        require(initial['nativeLoopFrameScheduling']['available'] is False, initial)

        malformed = [
            {},
            {'trackId': 0, 'action': 'record', 'absoluteFrame': 1, 'phaseEpoch': 1, 'settingsRevision': 1},
            {'trackId': 6, 'action': 'record', 'absoluteFrame': 1, 'phaseEpoch': 1, 'settingsRevision': 1},
            {'trackId': 1, 'action': 'dub', 'absoluteFrame': 1, 'phaseEpoch': 1, 'settingsRevision': 1},
            {'trackId': 1, 'action': 'record', 'absoluteFrame': -1, 'phaseEpoch': 1, 'settingsRevision': 1},
            {'trackId': 1, 'action': 'record', 'absoluteFrame': 1, 'phaseEpoch': 1, 'settingsRevision': 1, 'extra': True},
        ]
        for body in malformed:
            require(request('/v1/transport/rhythm-schedule', 'POST', body)[0] == 400,
                ('invalid schedule request accepted', body))
        for body in [{}, {'trackId': 0, 'revision': 1}, {'trackId': 1, 'revision': 0},
                     {'trackId': 1, 'revision': 1, 'extra': True}]:
            require(request('/v1/transport/rhythm-schedule/cancel', 'POST', body)[0] == 400,
                ('invalid cancel request accepted', body))

        config = {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1', 'outputDeviceId': 'WASAPI:1',
            'sampleRate': 48000, 'bufferFrames': 1024, 'monitoringEnabled': False}
        require(request('/v1/config/apply', 'POST', config)[0] == 200, 'engine config failed')
        code, rhythm = request('/v1/native-rhythm/config', 'POST', {'enabled': True, 'bpm': 300})
        require(code == 200, rhythm)
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'engine start failed')
        ready = until(phase_has_headroom)

        first = phase(ready)
        code, queued = request('/v1/transport/rhythm-schedule', 'POST', first)
        require(code == 200, queued)
        revision = queued['nativeLoopFrameScheduling']['acceptedRevision']
        require(queued['nativeLoopFrameScheduling']['acceptedTrackId'] == 2 and revision > 0, queued)
        require(request('/v1/transport/rhythm-schedule', 'POST', first)[0] == 409,
            'second pending schedule for the same track was accepted')
        cancelled = request('/v1/transport/rhythm-schedule/cancel', 'POST', {'trackId': 2, 'revision': revision})
        require(cancelled[0] == 200, cancelled)
        cancelled_status = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['cancelledRevision'] == revision)
        require(cancelled_status['nativeTracks'][1]['state'] == 'Empty', cancelled_status)

        current = until(phase_has_headroom)
        record_request = phase(current)
        code, accepted = request('/v1/transport/rhythm-schedule', 'POST', record_request)
        require(code == 200, accepted)
        record_revision = accepted['nativeLoopFrameScheduling']['acceptedRevision']
        recorded = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == record_revision
            and value['nativeTracks'][1]['state'] == 'Recording')

        stop_request = phase(recorded)
        stop_request['action'] = 'stop'
        code, accepted_stop = request('/v1/transport/rhythm-schedule', 'POST', stop_request)
        require(code == 200, accepted_stop)
        stop_revision = accepted_stop['nativeLoopFrameScheduling']['acceptedRevision']
        stopped = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == stop_revision
            and value['nativeTracks'][1]['state'] == 'Stopped')
        require(stopped['nativeRecordPlay']['quantizeAvailable'] is False and
            stopped['nativeLoopFrameScheduling']['available'] is False and
            stopped['nativeRhythm']['phase']['frameSchedulingAvailable'] is False, stopped)
        print('Native Rhythm schedule HTTP: field validation, cancel/status ACK, callback REC/STOP ACK; full quantize capability remains false')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
