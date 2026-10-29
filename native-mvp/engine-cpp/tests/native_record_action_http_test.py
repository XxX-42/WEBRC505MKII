"""REC ACTION control/callback/undo contract against the explicit no-hardware host."""
import os
os.environ.setdefault('WEBRC_NATIVE_BRIDGE_PORT', '17761')
import subprocess
import sys
import time
from native_bridge_http_simulation_test import request, require


def until(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        code, status = request('/v1/status')
        require(code == 200, status)
        if predicate(status):
            return status
        time.sleep(.005)
    raise AssertionError(('REC ACTION callback ACK timed out', status))


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)
        code, value = request('/v1/config/apply', 'POST', {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1',
            'outputDeviceId': 'WASAPI:1', 'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False})
        require(code == 200, value)
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'start failed')
        code, dub_request = request('/v1/native-dub-mode/config', 'POST', {'trackId': 1, 'mode': 'REPLACE1'})
        require(code == 200, dub_request)
        dub_revision = dub_request['nativeTracks'][0]['dubMode']['acceptedRevision']
        require(dub_request['nativeTracks'][0]['dubMode']['requestedRevision'] == dub_revision, dub_request)
        dub_applied = until(lambda status: status['nativeTracks'][0]['dubMode']['appliedRevision'] == dub_revision)
        require(dub_applied['nativeTracks'][0]['dubMode']['applied'] == 'REPLACE1', dub_applied)
        for action, expected in [('REC->PLAY', 'Playing'), ('REC->DUB', 'Overdubbing')]:
            code, value = request('/v1/record/settings', 'POST', {'recAction': action})
            require(code == 200, value)
            ready = until(lambda status: status['nativeRecordPlay']['recAction'] == action and
                status['nativeRecordPlay']['requestedRevision'] == status['nativeRecordPlay']['appliedRevision'])
            require(ready['nativeRecordPlay']['quantizeAvailable'] is False, ready)
            require(request('/v1/transport/record', 'POST', {'trackId': 1})[0] == 200, 'record failed')
            until(lambda status: status['nativeTracks'][0]['state'] == 'Recording')
            code, rejected_mode = request('/v1/native-dub-mode/config', 'POST', {'trackId': 1, 'mode': 'REPLACE2'})
            require(code == 409, ('DUB MODE changed during recording', rejected_mode))
            code, rejected = request('/v1/record/settings', 'POST', {'recAction': 'REC->DUB' if action == 'REC->PLAY' else 'REC->PLAY'})
            require(code == 409, rejected)
            code, accepted = request('/v1/transport/finish-record', 'POST', {'trackId': 1})
            require(code == 200, accepted)
            revision = accepted['nativeRecordPlay']['finishRequested'][0]
            committed = until(lambda status: status['nativeRecordPlay']['finishApplied'][0] == revision and status['nativeTracks'][0]['state'] == expected)
            require(committed['nativeRecordPlay']['recAction'] == action, committed)
            require(request('/v1/transport/finish-record', 'POST', {'trackId': 1})[0] == 409, 'duplicate completion accepted')
            if action == 'REC->DUB':
                require(request('/v1/transport/overdub-toggle', 'POST', {'trackId': 1})[0] == 200, 'commit dub failed')
                until(lambda status: status['nativeTracks'][0]['state'] == 'Playing')
            require(request('/v1/transport/stop', 'POST', {'trackId': 1})[0] == 200, 'stop failed')
            until(lambda status: status['nativeTracks'][0]['state'] == 'Stopped')
            require(request('/v1/transport/undo', 'POST', {'trackId': 1})[0] == 200, 'history unavailable after REC completion')
            require(request('/v1/transport/clear', 'POST', {'trackId': 1})[0] == 200, 'clear failed')
            until(lambda status: status['nativeTracks'][0]['state'] == 'Empty')
        for body in [{'recAction': 'INVALID'}, {'quantize': 'INVALID'}, {'recAction': 'REC->PLAY', 'quantize': 'MEASURE'}]:
            require(request('/v1/record/settings', 'POST', body)[0] == 400, ('invalid settings accepted', body))
        for body in [{'trackId': 0, 'mode': 'OVERDUB'}, {'trackId': 1, 'mode': 'INVALID'}]:
            require(request('/v1/native-dub-mode/config', 'POST', body)[0] == 400, ('invalid DUB MODE request accepted', body))
        print('Native REC ACTION: atomic REC->PLAY/REC->DUB, callback generations, shared-budget shadow and retained undo; measure quantize requires Native Rhythm')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
