"""Whole Memory HTTP transaction proof against the device-free host."""
import copy
import json
import os
import struct
import subprocess
import sys
import time
os.environ.setdefault('WEBRC_NATIVE_BRIDGE_PORT', '17759')
from native_bridge_http_simulation_test import (request, request_project_archive, build_project_archive, require)


def envelope(status, invalid=False):
    banks = [[{'effectId': 'fractional_delay' if slot == 0 else '', 'parameters': {}, 'bypassed': False}
              for slot in range(4)] for _ in range(7)]
    if invalid:
        banks[6][3]['effectId'] = 'missing_memory_effect'
    fx = copy.deepcopy(status['nativeFx'])
    fx['outputReverbEnabled'] = True
    fx['outputReverbWetMix'] = .4
    pitch = copy.deepcopy(status['nativePitch'])
    pitch.update(enabled=True, semitones=3)
    metadata = {'version': 1, 'memoryNumber': 1, 'name': 'Native test',
                'semantics': {'tempo': 120, 'meter': [4, 4], 'fields': {}},
                'extensions': {'WEBRC': {
                    'nativeMemory': {'banks': banks, 'mixerLevels': [80, 90, 100, 110, 120, 130, 140], 'trackFxApply': [False, True, False, True, False],
                        'rhythm': {'enabled': False, 'bpm': 120, 'kitIndex': 1, 'patternIndex': 1,
                            'variation': 0, 'section': 0, 'quantizeGrid': 0, 'swingPercent': 50, 'volume': 37},
                        'loopTransports': status['nativeMemory']['loopTransports']},
                    'nativeOutputState': {'fx': fx, 'pitch': pitch}}}}
    metadata_bytes = json.dumps(metadata, separators=(',', ':')).encode()
    archive = build_project_archive([{'channels': 2, 'samples': [.25, -.25, .5, -.5]}, None, None, None, None])
    return b'RC505ME1' + struct.pack('<I', len(metadata_bytes)) + metadata_bytes + archive


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)
        code, status = request('/v1/config/apply', 'POST', {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1',
            'outputDeviceId': 'WASAPI:1', 'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False})
        require(code == 200, status)
        code, status = request('/v1/engine/start', 'POST', {})
        require(code == 200, status)
        baseline = status['projectContentRevision']
        body = envelope(status)
        path = f'/v1/project/import?expectedContentRevision={baseline}'
        code, result = request_project_archive(path, 'POST', body, 'application/octet-stream')
        require(code == 202, result)
        generation = result['generation']
        time.sleep(.03)
        code, state = request(f'/v1/project/import/status?generation={generation}')
        require(code == 200 and state['state'] == 'prepared', state)
        code, before = request('/v1/status')
        require(before['projectContentRevision'] == baseline and before['nativeTracks'][0]['state'] == 'Empty', before)
        code, rejected = request('/v1/native-track-fx/apply', 'POST', {'trackId': 1, 'enabled': False})
        require(code == 409, rejected)
        code, cancelled = request_project_archive('/v1/project/import/cancel', 'POST',
            json.dumps({'generation': generation}).encode(), 'text/plain')
        require(code == 200 and cancelled['state'] == 'cancelled', cancelled)
        require(request('/v1/status')[1]['projectContentRevision'] == baseline, 'cancel mutated incumbent')
        code, result = request_project_archive(path, 'POST', body, 'application/octet-stream')
        require(code == 202, result)
        generation = result['generation']
        code, activated = request_project_archive('/v1/project/import/commit', 'POST', str(generation).encode(), 'text/plain')
        require(code == 200, activated)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, after = request('/v1/status')
            gates = after['nativeFx']['trackFxApply']
            if after['nativeTracks'][0]['state'] == 'Stopped' and all(g['requestedRevision'] == g['appliedRevision'] for g in gates):
                break
            time.sleep(.005)
        require([g['applied'] for g in gates] == [False, True, False, True, False], gates)
        fx = after['nativeFx']
        banks = [fx['inputCatalogSlots'], fx['catalogSlots']] + [bank['slots'] for bank in fx['perTrackCatalogBanks']]
        require(all(bank[0]['effectId'] == 'fractional_delay' for bank in banks), 'seven banks did not commit together')
        require(fx['outputReverbEnabled'] is True and abs(fx['outputReverbWetMix'] - .4) < 1e-5, fx)
        require(after['nativePitch']['enabled'] and after['nativePitch']['semitones'] == 3, after['nativePitch'])
        require(after['nativeRhythm']['volume'] == 37, after['nativeRhythm'])
        require(after['mixerLevels'] == [80, 90, 100, 110, 120, 130, 140], after['mixerLevels'])
        revision = after['projectContentRevision']
        code, rejected = request_project_archive(f'/v1/project/import?expectedContentRevision={revision}', 'POST',
            envelope(after, invalid=True), 'application/octet-stream')
        require(code == 409, rejected)
        require(request('/v1/status')[1]['projectContentRevision'] == revision, 'invalid candidate changed incumbent')
        for enabled in [True, False]:
            code, edited = request('/v1/native-track-fx/apply', 'POST', {'trackId': 1, 'enabled': enabled})
            require(code == 200, edited)
        code, rejected = request_project_archive(f'/v1/project/import?expectedContentRevision={revision}', 'POST',
            body, 'application/octet-stream')
        require(code == 409 and 'changed' in rejected.get('error', ''), rejected)
        print('Native whole Memory HTTP: prepare/cancel/atomic PCM+7FX+output+pitch+gates/ACK/invalid/ABA passed')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
