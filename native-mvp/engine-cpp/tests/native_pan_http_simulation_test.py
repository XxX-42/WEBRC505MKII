"""PAN CAS and semantic Memory integration against the no-device simulation host."""
import json
import os
import socket
import subprocess
import sys
import time

os.environ.setdefault('WEBRC_NATIVE_BRIDGE_PORT', '18757')
from native_bridge_http_simulation_test import request, request_project_archive, request_raw, require
from native_memory_http_simulation_test import envelope


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        code, status = request('/v1/status')
        require(code == 200, status)
        if predicate(status):
            return status
        time.sleep(.005)
    raise AssertionError(('callback timeout', status))


def add_captured_pans(meta, status):
    pans = list(status['nativeMemory']['trackPans'])
    meta['extensions']['WEBRC']['nativeMemory']['trackPans'] = pans
    for index, value in enumerate(pans, 1):
        meta['semantics']['fields'][f'track.{index}.pan'] = {'availability': 'supported', 'value': value}


def prepare(status, body):
    return request_project_archive(f"/v1/project/import?expectedContentRevision={status['projectContentRevision']}",
                                   'POST', body, 'application/octet-stream')


def commit(status, generation):
    code, result = request_project_archive('/v1/project/import/commit', 'POST', str(generation).encode(), 'text/plain')
    require(code == 200, result)
    return wait_for(lambda s: s['projectContentRevision'] > status['projectContentRevision'])


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', int(os.environ['WEBRC_NATIVE_BRIDGE_PORT'])))
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if process.poll() is not None: raise RuntimeError('simulation host exited')
            try:
                if request('/health')[0] == 200: break
            except Exception: time.sleep(.05)
        code, status = request('/v1/config/apply', 'POST', {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1',
            'outputDeviceId': 'WASAPI:1', 'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False})
        require(code == 200, status)
        host = status['hostIncarnationId']; headers = {'X-Native-Host-Incarnation': host}
        url = '/v1/native-track-pan/config'
        code, value = request(url, 'POST', {'trackId': 1, 'pan': 10, 'expectedRevision': 0}, headers)
        require(code == 409, ('stopped must reject', code, value))
        status = request('/v1/status')[1]
        require(status['nativeTracks'][0]['pan']['requestedRevision'] == 0, status)
        code, value = request('/v1/engine/start', 'POST', {})
        require(code == 200, value)
        for body, head, expected in [
            ({'trackId': 1, 'pan': 1, 'expectedRevision': 0}, {}, 409),
            ({'trackId': 1, 'pan': 1, 'expectedRevision': 0}, {'X-Native-Host-Incarnation': 'old'}, 409),
            *[({'trackId': t, 'pan': p, 'expectedRevision': 0}, headers, 400)
              for t, p in [(0, 1), (6, 1), (1, 51), (1, -51), (1, True), (1, 2**64-1), (True, 0)]],
            ({'trackId': 1, 'pan': 1.5, 'expectedRevision': 0}, headers, 400),
        ]:
            code, result = request(url, 'POST', body, head)
            require(code == expected, (body, code, result))
        for track, pan in enumerate([-50, -25, 0, 25, 50], 1):
            code, result = request(url, 'POST', {'trackId': track, 'pan': pan, 'expectedRevision': 0}, headers)
            require(code == 200, result)
            accepted = result['nativeTracks'][track - 1]['pan']['acceptedRevision']
            require(accepted == 1, result)
            status = wait_for(lambda s: s['nativeTracks'][track - 1]['pan']['appliedRevision'] == accepted)
            require(status['nativeTracks'][track - 1]['pan']['applied'] == pan, status)
        code, result = request(url, 'POST', {'trackId': 1, 'pan': 9, 'expectedRevision': 0}, headers)
        require(code == 409, ('stale CAS', result))
        require(status['nativeMemory']['trackPans'] == [-50, -25, 0, 25, 50], status)
        body = envelope(status, mutate=lambda m: add_captured_pans(m, status))
        code, prepared = prepare(status, body); require(code == 202, prepared)
        generation = prepared['generation']
        before = request('/v1/status')[1]
        require(before['nativeMemory']['trackPans'] == status['nativeMemory']['trackPans'], before)
        code, result = request(url, 'POST', {'trackId': 1, 'pan': 10, 'expectedRevision': 1}, headers)
        require(code == 409, ('prepared Memory must fence PAN', result))
        installed = commit(status, generation)
        require(installed['nativeMemory']['trackPans'] == [-50, -25, 0, 25, 50], installed)
        for track in installed['nativeTracks']:
            p = track['pan']; require(p['requestedRevision'] == p['appliedRevision'] == 2 and p['applied'] == p['requested'], p)
        code, result = request(url, 'POST', {'trackId': 1, 'pan': 1, 'expectedRevision': 1}, headers)
        require(code == 409, ('Memory must invalidate stale CAS', result))
        code, _, pcm_before = request_raw('/v1/export/loop-snapshot?trackId=1')
        require(code == 200 and pcm_before, 'PCM capture failed')
        def invalid(meta, kind):
            add_captured_pans(meta, installed)
            fields = meta['semantics']['fields']; pans = meta['extensions']['WEBRC']['nativeMemory']['trackPans']
            if kind == 'missing': fields.pop('track.3.pan')
            elif kind == 'unsupported': fields['track.3.pan'] = {'availability': 'unsupported', 'value': None, 'reason': 'test'}
            elif kind == 'mismatch': fields['track.3.pan']['value'] = 1
            elif kind == 'huge': pans[2] = 2**64-1
            elif kind == 'bool': pans[2] = True
            elif kind == 'length': pans.pop()
        for kind in ('missing', 'unsupported', 'mismatch', 'huge', 'bool', 'length'):
            code, result = prepare(installed, envelope(installed, mutate=lambda m: invalid(m, kind)))
            require(code == 400, (kind, code, result))
            after = request('/v1/status')[1]
            code, _, pcm = request_raw('/v1/export/loop-snapshot?trackId=1')
            require(code == 200 and pcm == pcm_before and after['projectContentRevision'] == installed['projectContentRevision']
                    and after['nativeMemory']['trackPans'] == installed['nativeMemory']['trackPans']
                    and [t['pan'] for t in after['nativeTracks']] == [t['pan'] for t in installed['nativeTracks']], kind)
        code, prepared = prepare(installed, envelope(installed))
        require(code == 202, ('legacy without PAN rejected', prepared))
        legacy = commit(installed, prepared['generation'])
        require(legacy['nativeMemory']['trackPans'] == [0] * 5, legacy)
        for t in legacy['nativeTracks']:
            require(t['pan']['applied'] == t['pan']['requested'] == 0 and
                    t['pan']['requestedRevision'] == t['pan']['appliedRevision'] == 3, t)
        print('PASS: PAN HTTP CAS, Memory semantic validation, atomic install and legacy defaults')
    finally:
        process.terminate(); process.wait(timeout=5)


if __name__ == '__main__': main()
