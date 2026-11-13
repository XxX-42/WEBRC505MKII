"""AUTO REC Memory transaction proof against the device-free HTTP host."""
import os
import socket
import subprocess
import sys
import time

os.environ.setdefault('WEBRC_NATIVE_BRIDGE_PORT', '18756')
from native_bridge_http_simulation_test import request, request_project_archive, request_raw, require
from native_memory_http_simulation_test import envelope


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        _, status = request('/v1/status')
        if predicate(status):
            return status
        time.sleep(.01)
    raise AssertionError(('timed out waiting for callback', status))


def import_memory(status, body):
    code, prepared = request_project_archive(
        f"/v1/project/import?expectedContentRevision={status['projectContentRevision']}",
        'POST', body, 'application/octet-stream')
    require(code == 202, prepared)
    generation = prepared['generation']
    code, committed = request_project_archive('/v1/project/import/commit', 'POST', str(generation).encode(), 'text/plain')
    require(code == 200, committed)
    return wait_for(lambda s: s['nativeTracks'][0]['state'] == 'Stopped'
                    and s['projectContentRevision'] > status['projectContentRevision'])


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', int(os.environ['WEBRC_NATIVE_BRIDGE_PORT'])))
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('simulation host exited before becoming ready')
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)
        code, result = request('/v1/config/apply', 'POST', {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1',
            'outputDeviceId': 'WASAPI:1', 'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False})
        require(code == 200, result)
        code, result = request('/v1/engine/start', 'POST', {})
        require(code == 200, result)
        initial = request('/v1/status')[1]
        body = envelope(initial, mutate=lambda m: m['extensions']['WEBRC']['nativeMemory'].update(
            autoRec={'enabled': True, 'sensitivity': 1}))
        installed = import_memory(initial, body)
        settings = installed['nativeAutoRec']['settings']
        require(settings['enabled'] is True and settings['sensitivity'] == 1 and
                settings['requestedRevision'] == settings['appliedRevision'], settings)
        code, _, pcm_before = request_raw('/v1/export/loop-snapshot?trackId=1')
        require(code == 200 and pcm_before, 'could not capture incumbent PCM')
        headers = {'X-Native-Host-Incarnation': installed['hostIncarnationId']}
        code, armed = request('/v1/transport/record/auto-rec?trackId=2', 'POST',
            {'intentId': '11111111111111111111111111111111', 'expectedArmRevision': 0}, headers)
        require(code == 200, armed)
        stable = wait_for(lambda s: s['nativeAutoRec']['tracks'][1]['armAppliedRevision'] == 1)
        require(stable['nativeAutoRec']['tracks'][1]['armed'], stable['nativeAutoRec'])
        code, rejected = request_project_archive(
            f"/v1/project/import?expectedContentRevision={stable['projectContentRevision']}",
            'POST', envelope(stable), 'application/octet-stream')
        require(code == 409, ('armed Memory import accepted', code, rejected))
        after = request('/v1/status')[1]
        code, _, pcm_after = request_raw('/v1/export/loop-snapshot?trackId=1')
        require(code == 200 and pcm_before == pcm_after and
                after['projectContentRevision'] == stable['projectContentRevision'] and
                after['nativeAutoRec']['settings'] == stable['nativeAutoRec']['settings'] and
                after['nativeAutoRec']['tracks'][1]['armed'], 'rejected import changed incumbent')
        code, cancelled = request('/v1/transport/record/auto-rec/cancel?trackId=2', 'POST',
            {'intentId': '11111111111111111111111111111111', 'armRevision': 1}, headers)
        require(code == 200, cancelled)
        legacy = import_memory(request('/v1/status')[1], envelope(after))
        settings = legacy['nativeAutoRec']['settings']
        require(settings['enabled'] is False and settings['sensitivity'] == 50 and
                settings['requestedRevision'] == settings['appliedRevision'], settings)
        print('PASS: AUTO REC Memory commit, armed import rejection/PCM preservation, legacy OFF/50')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
