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


def envelope(status, invalid=False, mutate=None):
    banks = [[{'effectId': 'fractional_delay' if slot == 0 else '', 'parameters': {}, 'bypassed': False}
              for slot in range(4)] for _ in range(7)]
    if invalid:
        banks[6][3]['effectId'] = 'missing_memory_effect'
    fx = copy.deepcopy(status['nativeFx'])
    fx['outputReverbEnabled'] = True
    fx['outputReverbWetMix'] = .4
    pitch = copy.deepcopy(status['nativePitch'])
    pitch.update(enabled=True, semitones=3)
    bounce = {'bounceSw': True, 'bounceIn': [True, False, True, False, False],
        'bounceTrack': [False, True, True, False, True]}
    bounce_fields = {'record.bounceSw': {'availability': 'supported', 'value': True}}
    dub_modes = ['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1']
    for track in range(1, 6):
        bounce_fields[f'track.{track}.bounceIn'] = {'availability': 'supported', 'value': bounce['bounceIn'][track - 1]}
        bounce_fields[f'track.{track}.bounceTrack'] = {'availability': 'supported', 'value': bounce['bounceTrack'][track - 1]}
        bounce_fields[f'track.{track}.dubMode'] = {'availability': 'supported', 'value': dub_modes[track - 1]}
    metadata = {'version': 1, 'memoryNumber': 1, 'name': 'Native test',
                'semantics': {'tempo': 120, 'meter': [4, 4], 'fields': bounce_fields},
                'extensions': {'WEBRC': {
                    'nativeMemory': {'banks': banks, 'mixerLevels': [80, 90, 100, 110, 120, 130, 140], 'trackFxApply': [False, True, False, True, False],
                        'rhythm': {'enabled': False, 'bpm': 120, 'kitIndex': 1, 'patternIndex': 1,
                            'variation': 0, 'section': 0, 'quantizeGrid': 0, 'swingPercent': 50, 'volume': 37},
                        'loopTransports': status['nativeMemory']['loopTransports'], 'dubModes': dub_modes, 'bounce': bounce},
                    'nativeOutputState': {'fx': fx, 'pitch': pitch}}}}
    if mutate:
        mutate(metadata)
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
        status_code, source_status = request('/v1/status')
        require(status_code == 200, source_status)
        saved_transport = source_status['nativeMemory']['loopTransports'][1]
        transport_modes = {0: 'off', 1: 'beatShift', 2: 'vinylFlick'}
        source_transport = dict(saved_transport)
        source_transport['mode'] = transport_modes[saved_transport['mode']]
        code, requested_transport = request('/v1/native-loop-transport/config', 'POST',
            {'trackId': 2, **source_transport, 'oneShot': True, 'reverse': True})
        require(code == 200, requested_transport)
        accepted_transport_revision = requested_transport['nativeTracks'][1]['loopTransportAcceptedRevision']
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, source_status = request('/v1/status')
            track_transport = source_status['nativeTracks'][1]
            if track_transport['loopTransportAppliedRevision'] == accepted_transport_revision:
                break
            time.sleep(.005)
        require(track_transport['loopTransportAppliedRevision'] == accepted_transport_revision and
                track_transport['loopTransportAppliedOneShot'] is True and
                track_transport['loopTransportAppliedReverse'] is True and
                source_status['nativeMemory']['loopTransports'][1]['oneShot'] is True and
                source_status['nativeMemory']['loopTransports'][1]['reverse'] is True,
                'Native REVERSE/1SHOT did not round-trip through applied status before Memory export')
        baseline = source_status['projectContentRevision']
        # Older Native Memory envelopes did not carry per-track DUB MODE.
        # They remain valid and restore the documented legacy default.
        def remove_dub_modes(meta):
            native = meta['extensions']['WEBRC']['nativeMemory']
            native.pop('dubModes', None)
            for track in range(1, 6):
                meta['semantics']['fields'].pop(f'track.{track}.dubMode', None)
        legacy_body = envelope(source_status, mutate=remove_dub_modes)
        code, legacy = request_project_archive(f'/v1/project/import?expectedContentRevision={baseline}', 'POST', legacy_body, 'application/octet-stream')
        require(code == 202, ('legacy Memory without DUB MODE was rejected', legacy))
        legacy_generation = legacy['generation']
        code, legacy = request_project_archive('/v1/project/import/cancel', 'POST', json.dumps({'generation': legacy_generation}).encode(), 'text/plain')
        require(code == 200 and legacy['state'] == 'cancelled', ('legacy candidate did not cancel cleanly', legacy))
        legacy_after = request('/v1/status')[1]
        require(legacy_after['projectContentRevision'] == baseline
            and legacy_after['nativeMemory']['dubModes'] == ['OVERDUB'] * 5,
            'legacy prepare/cancel changed incumbent DUB MODE settings')
        body = envelope(source_status)
        malformed = [
            lambda meta: meta['extensions']['WEBRC']['nativeMemory'].update(recAction='INVALID'),
            lambda meta: meta.update(memoryNumber=0),
            lambda meta: meta.update(memoryNumber=100),
            lambda meta: meta.update(memoryNumber=True),
            lambda meta: meta.update(name='1234567890123'),
            lambda meta: meta.update(name='x\x00'),
            lambda meta: meta.update(name='😀' * 13),
            lambda meta: meta['semantics'].update(meter=[3, 4]),
            lambda meta: meta['semantics'].update(meter=[4, 3]),
            lambda meta: meta['semantics'].update(extra='unknown'),
            lambda meta: meta['semantics']['fields'].update({'track.1.level': {'availability': 'supported', 'value': 1}}),
            lambda meta: meta['semantics']['fields'].update({'track.9.level': {'availability': 'unsupported', 'value': None, 'reason': 'unknown'}}),
            lambda meta: meta['semantics']['fields'].update({'track.1.pan': {'availability': 'unsupported', 'value': 0, 'reason': 'unsupported'}}),
            lambda meta: meta['semantics']['fields'].update({'track.1.pan': {'availability': 'unknown', 'value': None}}),
            lambda meta: meta['semantics']['fields'].update({'track.1.pan': {'availability': 'supported', 'value': 'CENTER', 'unexpected': True}}),
            lambda meta: meta['extensions']['WEBRC']['nativeMemory'].update(dubModes=['OVERDUB']),
            lambda meta: meta['extensions']['WEBRC']['nativeMemory'].update(dubModes=['OVERDUB'] * 4 + ['INVALID']),
            lambda meta: meta['semantics']['fields']['track.3.dubMode'].update(value='OVERDUB'),
            lambda meta: meta['extensions']['WEBRC'].update({'opaque': {'prototype': 1}}),
            lambda meta: meta['extensions']['WEBRC'].update({'opaque': 'x' * 8193}),
        ]
        for index, mutate in enumerate(malformed):
            code, rejected = request_project_archive(f'/v1/project/import?expectedContentRevision={baseline}', 'POST',
                envelope(source_status, mutate=mutate), 'application/octet-stream')
            require(code == 400, f'malformed external Memory case {index} accepted: {code} {rejected}')
            _, unchanged = request('/v1/status')
            require(unchanged['projectContentRevision'] == baseline and unchanged['nativeTracks'][0]['state'] == 'Empty',
                f'malformed external Memory case {index} changed incumbent')
        body = envelope(source_status, mutate=lambda meta: (meta.update(name='😀' * 12),
            meta['extensions']['WEBRC'].update({'opaque': {'nested': [1, {'vendorValue': True}]}}),
            meta['extensions']['WEBRC']['nativeMemory'].update(recAction='REC->DUB'),
            meta['semantics']['fields'].update({'record.recAction': {'availability': 'supported', 'value': 'REC->DUB'}}),
            meta['semantics']['fields'].update({'assign.vendorField': {'availability': 'unknown', 'value': None, 'reason': 'Opaque foreign provider value.'}})))
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
        cancel_path = '/v1/project/import/cancel'
        cancel_body = json.dumps({'generation': generation}).encode()
        for content_type in ('text/plainX', 'text/plainX;charset=UTF-8', 'application/json'):
            code, rejected = request_project_archive(cancel_path, 'POST', cancel_body, content_type)
            require(code == 415, f'cancel media type {content_type}: {code} {rejected}')
        for invalid_body in (b'{}', b'{"generation":0}', b'{"generation":true}',
                             b'{"generation":1,"extra":true}', b'not-json'):
            code, rejected = request_project_archive(cancel_path, 'POST', invalid_body, 'text/plain;charset=UTF-8')
            require(code == 400, f'cancel schema accepted: {code} {rejected}')
        # Match the browser Fetch Content-Type exactly, then prove case/OWS and
        # bare-token forms on the same idempotently cancelled generation.
        for content_type in ('text/plain;charset=UTF-8', 'Text/Plain ; Charset=UTF-8', 'text/plain'):
            code, cancelled = request_project_archive(cancel_path, 'POST', cancel_body, content_type)
            require(code == 200 and cancelled['state'] == 'cancelled',
                    f'cancel media type {content_type}: {code} {cancelled}')
        require(request('/v1/status')[1]['projectContentRevision'] == baseline, 'cancel mutated incumbent')
        require(request('/v1/status')[1]['nativeMemory']['dubModes'] == ['OVERDUB'] * 5,
            'cancelled non-default DUB MODE candidate mutated incumbent settings')
        mismatched_bounce = lambda meta: meta['semantics']['fields']['track.3.bounceIn'].update(value=False)
        code, rejected = request_project_archive(path, 'POST', envelope(source_status, mutate=mismatched_bounce), 'application/octet-stream')
        require(code == 400, ('inconsistent Bounce semantic field accepted', rejected))
        code, result = request_project_archive(path, 'POST', body, 'application/octet-stream')
        require(code == 202, result)
        generation = result['generation']
        code, activated = request_project_archive('/v1/project/import/commit', 'POST', str(generation).encode(), 'text/plain')
        require(code == 200, activated)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, after = request('/v1/status')
            gates = after['nativeFx']['trackFxApply']
            if after['nativeTracks'][0]['state'] == 'Stopped' and all(g['requestedRevision'] == g['appliedRevision'] for g in gates) \
                    and after['nativeBounce']['requestedRevision'] == after['nativeBounce']['appliedRevision']:
                break
            time.sleep(.005)
        require([g['applied'] for g in gates] == [False, True, False, True, False], gates)
        fx = after['nativeFx']
        banks = [fx['inputCatalogSlots'], fx['catalogSlots']] + [bank['slots'] for bank in fx['perTrackCatalogBanks']]
        require(all(bank[0]['effectId'] == 'fractional_delay' for bank in banks), 'seven banks did not commit together')
        require(fx['outputReverbEnabled'] is True and abs(fx['outputReverbWetMix'] - .4) < 1e-5, fx)
        require(after['nativePitch']['enabled'] and after['nativePitch']['semitones'] == 3, after['nativePitch'])
        require(after['nativeRhythm']['volume'] == 37, after['nativeRhythm'])
        require(after['nativeMemory']['bounce'] == {'bounceSw': True, 'bounceIn': [True, False, True, False, False],
            'bounceTrack': [False, True, True, False, True]}, after['nativeMemory'])
        require(after['nativeMemory']['loopTransports'][1]['oneShot'] is True and
                after['nativeTracks'][1]['loopTransportAppliedOneShot'] is True,
                'Native Memory did not restore the requested 1SHOT mode to the callback-applied setting')
        require(after['nativeMemory']['dubModes'] == ['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1'], after['nativeMemory'])
        require([track['dubMode']['applied'] for track in after['nativeTracks']] == after['nativeMemory']['dubModes'], after['nativeTracks'])
        require(all(track['phaseProvenance']['verified'] is False for track in after['nativeTracks']),
            ('Native Memory import fabricated PCM phase provenance', after['nativeTracks']))
        require(all(track['dubMode']['requested'] == track['dubMode']['applied']
            and track['dubMode']['requestedRevision'] == track['dubMode']['appliedRevision'] for track in after['nativeTracks']), after['nativeTracks'])
        require(after['nativeRecordPlay']['recAction'] == 'REC->DUB' and after['nativeRecordPlay']['requestedRevision'] == after['nativeRecordPlay']['appliedRevision'], after['nativeRecordPlay'])
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
        # Importing an old saved Memory after a non-default mode commit must
        # restore the historical OVERDUB default on all five tracks.
        current_revision = request('/v1/status')[1]['projectContentRevision']
        old_body = envelope(after, mutate=remove_dub_modes)
        code, old_candidate = request_project_archive(f'/v1/project/import?expectedContentRevision={current_revision}', 'POST',
            old_body, 'application/octet-stream')
        require(code == 202, ('legacy Memory restore was rejected', old_candidate))
        code, old_commit = request_project_archive('/v1/project/import/commit', 'POST', str(old_candidate['generation']).encode(), 'text/plain')
        require(code == 200, old_commit)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, restored = request('/v1/status')
            if restored['projectContentRevision'] > current_revision and restored['nativeMemory']['dubModes'] == ['OVERDUB'] * 5 \
                    and all(track['dubMode']['requestedRevision'] == track['dubMode']['appliedRevision'] for track in restored['nativeTracks']):
                break
            time.sleep(.005)
        require(all(track['phaseProvenance']['verified'] is False for track in restored['nativeTracks']),
            ('legacy Native Memory import fabricated PCM phase provenance', restored['nativeTracks']))
        require(restored['nativeMemory']['dubModes'] == ['OVERDUB'] * 5
            and all(track['dubMode']['applied'] == 'OVERDUB'
                and track['dubMode']['requestedRevision'] == track['dubMode']['appliedRevision'] for track in restored['nativeTracks']),
            ('legacy Memory did not restore DUB MODE defaults', restored['nativeTracks']))
        print('Native whole Memory HTTP: external schema/meter/fields/Unicode/opaque + prepare/cancel/atomic PCM+7FX+output+pitch+gates/ACK/invalid/ABA passed')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
