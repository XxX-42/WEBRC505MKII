#!/usr/bin/env python3
"""No-device contract for additive official DSP descriptors and host controls."""
import json
import os
import subprocess
import sys
import time
import urllib.error
sys.dont_write_bytecode = True
from native_bridge_http_simulation_test import request, require


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            require(process.poll() is None, 'simulation host exited before health check')
            try:
                if request('/health')[0] == 200:
                    break
            except (ConnectionError, TimeoutError, urllib.error.URLError):
                time.sleep(0.05)
        status, result = request('/v1/config/apply', 'POST', {
            'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1', 'outputDeviceId': 'WASAPI:1',
            'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False})
        require(status == 200, f'configure rejected: {result}')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'start failed')
        require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'stop failed')
        status, result = request('/v1/status')
        fx = result['nativeFx']
        require(fx['parameterSchemaVersion'] == 1, 'legacy schema version changed')
        require(fx.get('catalogParameterReplacement') is True, 'replacement contract capability missing')
        # Uniform request/application metadata for all seven four-slot banks.
        def slots_for(current, bank):
            state = current['nativeFx']
            return (state['inputCatalogSlots'] if bank == 0 else state['catalogSlots'] if bank == 1
                    else state['perTrackCatalogBanks'][bank - 2]['slots'])
        for bank in range(7):
            require([s['slot'] for s in slots_for(result, bank)] == list('ABCD'), 'four-slot bank contract changed')
            body = {'path': 'input' if bank == 0 else 'track', 'slot': 'D', 'effectId': 'filter.lpf',
                    'parameters': {'cutoff_hz': 1234}, 'bypassed': True, 'replaceParameters': True}
            if bank >= 2:
                body['trackId'] = bank - 1
            code, configured = request('/v1/native-fx/catalog-slot', 'POST', body)
            require(code == 200, f'catalog ACK setup failed: {configured}')
            slot = slots_for(configured, bank)[3]
            require(slot['parameters'] == {'cutoff_hz': 1234}, 'authored snapshot differs')
            require(slot['requestedRevision'] == slot['appliedRevision'] and slot['appliedRevision'] > 0,
                    'stopped write was not acknowledged')
            require(slot['bypassed'] and slot['appliedBypassed'] and slot['prepared'] and not slot['controlFaulted'],
                    'stopped bypass/prepared ACK differs')
            require(request('/v1/engine/start', 'POST', {})[0] == 200, 'ACK test start failed')
            body['parameters'] = {'cutoff_hz': 2345}
            body['bypassed'] = False
            code, accepted = request('/v1/native-fx/catalog-slot', 'POST', body)
            require(code == 200, f'live same-type write rejected: {accepted}')
            revision = slots_for(accepted, bank)[3]['requestedRevision']
            # Pending is tested deterministically in native_catalog_ack_tests;
            # an asynchronous HTTP response may already include callback completion.
            for _ in range(100):
                _, current = request('/v1/status')
                slot = slots_for(current, bank)[3]
                if slot['appliedRevision'] == revision:
                    break
                time.sleep(0.01)
            require(slot['requestedRevision'] == slot['appliedRevision'] == revision, 'callback ACK did not arrive')
            require(slot['parameters'] == {'cutoff_hz': 2345} and not slot['appliedBypassed'] and not slot['controlFaulted'],
                    'live parameter/bypass ACK differs')
            clear = dict(body, slot='C', effectId='', parameters={})
            require(request('/v1/native-fx/catalog-slot', 'POST', clear)[0] == 409, 'live empty clear falsely ACKed')
            require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'ACK test stop failed')
            require(request('/v1/native-fx/catalog-slot', 'POST', dict(body, effectId='', parameters={}))[0] == 200,
                    'ACK fixture cleanup failed')
        entries = fx['catalogEffectAvailability']
        require(sum(len(item['parameters']) for item in entries) == 252, 'legacy controls changed')
        if os.environ.get('NATIVE_OFFICIAL_SCHEMA_OUTPUT'):
            with open(os.environ['NATIVE_OFFICIAL_SCHEMA_OUTPUT'], 'w', encoding='utf-8') as out:
                json.dump({'parameterSchemaVersion': 1, 'catalogParameterReplacement': fx['catalogParameterReplacement'], 'catalogEffectAvailability': entries}, out, indent=2)
                out.write('\n')
        for source_id in ('beat_shift', 'vinyl_flick'):
            source = next(item for item in entries if item['effectId'] == source_id)
            require(all(p.get('semanticSupport') == 'partial_source_modes' for p in source['officialParameters']),
                    f'source-mode boundary missing for {source_id}')
        vocoder = next(item for item in entries if item['effectId'] == 'vocoder')
        carrier = next(p for p in vocoder['officialParameters'] if p['id'] == 'official_carrier')
        require(carrier['minimum'] == 6 and carrier['maximum'] == 10 and carrier['defaultValue'] == 6,
                'carrier bounds/default do not match TRACK1-5')
        require(carrier['discreteValues'] == [6, 7, 8, 9, 10] and carrier['semanticSupport'] == 'partial_source_modes',
                'carrier partial domain missing')
        require('Physical MIC/INST' in carrier.get('limitation', '') and 'pitch' in carrier['limitation'],
                'carrier source limitations missing')
        carrier_body = {'path': 'input', 'slot': 'A', 'effectId': 'vocoder',
                        'parameters': {'carrier': 1, 'mix_percent': 100}, 'replaceParameters': True}
        require(request('/v1/native-fx/catalog-slot', 'POST', carrier_body)[0] == 200, 'legacy carrier setup failed')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'carrier start failed')
        def wait_carrier_status(expected, track=0):
            for _ in range(100):
                _, current = request('/v1/status')
                if current['nativeTracks'][track]['vocoderCarrierStatus'] == expected:
                    return
                time.sleep(0.01)
            raise AssertionError(f'carrier status did not reach {expected}: {current["nativeTracks"][track]}')
        for invalid in range(6):
            carrier_body['parameters'] = {'carrier': 1, 'mix_percent': 100, 'official_carrier': invalid, 'official_balance': 100}
            rejected_status, rejected_carrier = request('/v1/native-fx/catalog-slot', 'POST', carrier_body)
            require(rejected_status == 409 and 'official_carrier' in rejected_carrier.get('error', ''),
                    f'physical carrier {invalid} was silently accepted or rejected for the wrong reason')
        time.sleep(0.02)
        wait_carrier_status('notRequested')
        carrier_body['parameters'] = {'official_carrier': 6, 'official_balance': 100}
        require(request('/v1/native-fx/catalog-slot', 'POST', carrier_body)[0] == 409,
                'removal of legacy authored fields while running must still require a stop')
        carrier_body['replaceParameters'] = False
        require(request('/v1/native-fx/catalog-slot', 'POST', carrier_body)[0] == 200, 'track carrier rejected')
        wait_carrier_status('empty')
        require(request('/v1/transport/record', 'POST', {})[0] == 200, 'carrier record failed')
        wait_carrier_status('unsupportedRecording')
        require(request('/v1/transport/stop', 'POST', {})[0] == 200, 'carrier stop failed')
        wait_carrier_status('stopped')
        require(request('/v1/transport/play', 'POST', {})[0] == 200, 'carrier playback failed')
        wait_carrier_status('ready')
        require(request('/v1/transport/overdub-toggle', 'POST', {})[0] == 200, 'carrier overdub failed')
        wait_carrier_status('unsupportedOverdubbing')
        require(request('/v1/transport/overdub-toggle', 'POST', {})[0] == 200, 'carrier overdub exit failed')
        require(request('/v1/native-pitch/config', 'POST', {'enabled': True, 'trackId': 1})[0] == 200, 'carrier pitch failed')
        wait_carrier_status('unsupportedPitchProcessing')
        require(request('/v1/native-pitch/config', 'POST', {'enabled': False})[0] == 200, 'carrier pitch clear failed')
        wait_carrier_status('ready')
        require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'carrier engine stop failed')
        wait_carrier_status('notRequested')
        carrier_body.update(effectId='', parameters={})
        require(request('/v1/native-fx/catalog-slot', 'POST', carrier_body)[0] == 200, 'carrier replacement failed')
        wait_carrier_status('notRequested')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'carrier cleanup start failed')
        require(request('/v1/transport/clear', 'POST', {})[0] == 200, 'carrier loop cleanup failed')
        time.sleep(0.02)
        require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'carrier cleanup stop failed')
        total = 0
        for item in entries:
            descriptors = item.get('officialParameters', [])
            if not descriptors:
                continue
            total += len(descriptors)
            require(len({d['id'] for d in descriptors}) == len(descriptors), 'duplicate descriptor')
            require(all(d['id'].startswith('official_') and d['id'] not in ('official_bpm', 'official_quarter_notes_per_measure') for d in descriptors), 'internal/legacy control leaked')
            require(all(d['implementation'] == 'clean-room' and d['hardwareEquivalent'] is False for d in descriptors), 'unsupported parity claim')
            for variant in ((1, 2) if item['effectId'] in ('tape_echo', 'roll') else (None,)):
                applicable = [d for d in descriptors if variant is None or variant in d['applicableVariants']]
                def domain_value(d, maximum=False):
                    if d['id'] == 'official_variant':
                        return variant
                    domain = d.get('variantDomains', {}).get(str(variant))
                    if domain:
                        if maximum:
                            return max([domain['maximum']] + domain['values'])
                        if domain['documentedDefault'] is not None:
                            return domain['documentedDefault']
                    return d['maximum' if maximum else 'defaultValue']
                parameters = {d['id']: domain_value(d) for d in applicable}
                parameters['official_bpm'] = 120
                parameters['official_quarter_notes_per_measure'] = 3
                body = {'path': 'input' if item['input'] else 'track', 'slot': 'A', 'effectId': item['effectId'], 'parameters': parameters, 'bypassed': False}
                status, result = request('/v1/native-fx/catalog-slot', 'POST', body)
                require(status == 200, f'official defaults rejected: {item["effectId"]}/{variant}: {result}')
                require(request('/v1/engine/start', 'POST', {})[0] == 200, 'restart failed')
                body['parameters'] = {d['id']: domain_value(d, True) for d in applicable}
                body['parameters']['official_bpm'] = 180
                body['parameters']['official_quarter_notes_per_measure'] = 3.5
                status, result = request('/v1/native-fx/catalog-slot', 'POST', body)
                require(status == 200, f'live official updates rejected: {item["effectId"]}/{variant}: {result}')
                require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'stop after update failed')
        require(total >= 75, f'official descriptor coverage regressed: {total}')
        reset_body = {'path': 'input', 'slot': 'A', 'effectId': 'step_slicer',
                      'parameters': {'official_depth': 0, 'official_comp_gain': 20}, 'replaceParameters': True}
        require(request('/v1/native-fx/catalog-slot', 'POST', reset_body)[0] == 200, 'replacement setup failed')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'replacement start failed')
        reset_body['parameters'] = {'official_depth': 0}
        status, rejected = request('/v1/native-fx/catalog-slot', 'POST', reset_body)
        require(status == 409 and 'Stop Native audio' in rejected.get('error', ''), 'live removal falsely ACKed')
        reset_body['parameters'] = {}
        status, rejected = request('/v1/native-fx/catalog-slot', 'POST', reset_body)
        require(status == 409 and 'Stop Native audio' in rejected.get('error', ''), 'live reset falsely ACKed')
        reset_body['replaceParameters'] = False
        require(request('/v1/native-fx/catalog-slot', 'POST', reset_body)[0] == 200, 'legacy patch contract changed')
        require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'replacement stop failed')
        reset_body['replaceParameters'] = True
        require(request('/v1/native-fx/catalog-slot', 'POST', reset_body)[0] == 200, 'stopped replacement failed')
        reset_body['replaceParameters'] = 1
        require(request('/v1/native-fx/catalog-slot', 'POST', reset_body)[0] == 400, 'nonboolean replacement accepted')
        # Prospective-branch validation must precede every bank/queue mutation;
        # source maps are lexicographically ordered, so BASS must not run first.
        for effect, branch_one, branch_two in (('tape_echo', 'official_bass', 'official_high_cut'),
                                               ('roll', 'official_feedback', 'official_repeat')):
            body = {'path': 'input', 'slot': 'A', 'effectId': effect,
                    'parameters': {'official_variant': 1, branch_one: 20}}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 200, 'branch-one batch rejected')
            require(request('/v1/engine/start', 'POST', {})[0] == 200, 'variant test start failed')
            body['parameters'] = {'official_variant': 2, branch_two: 100}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 200, 'live variant switch rejected')
            body['parameters'] = {branch_two: 50}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 200, 'accepted variant shadow was stale')
            body['parameters'] = {'official_variant': 1, branch_two: 50}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 409, 'wrong-branch batch accepted')
            body['parameters'] = {branch_two: 60}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 200, 'rejected batch changed selected branch')
            require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'variant test stop failed')
            body['parameters'] = {}
            body['effectId'] = ''
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 200, 'clear variant failed')
            body['effectId'] = effect
            body['parameters'] = {branch_one: 20}
            require(request('/v1/native-fx/catalog-slot', 'POST', body)[0] == 409, 'missing explicit variant accepted')
        for effect in ('beat_scatter', 'beat_repeat', 'beat_shift', 'vinyl_flick'):
            for path, slot, track in (('input', 'A', 0), ('track', 'B', 0), ('track', 'D', 1)):
                status, rejected = request('/v1/native-fx/catalog-slot', 'POST', {
                    'path': path, 'slot': slot, 'trackId': track, 'effectId': effect,
                    'parameters': {'official_bpm': 120}})
                require(status == 409 and 'Track FX slot A' in rejected.get('error', ''),
                        f'official Track-A scope accepted: {effect}, {path}, {slot}, {track}: {rejected}')
        status, rejected = request('/v1/native-fx/catalog-slot', 'POST', {
            'path': 'track', 'slot': 'A', 'trackId': 1, 'effectId': 'vinyl_flick',
            'parameters': {'official_flick': 50}})
        require(status == 409 and 'Source-aware' in rejected.get('error', ''), 'private VINYL bypassed source-aware guard')
        status, _ = request('/v1/native-fx/catalog-slot', 'POST', {
            'path': 'track', 'slot': 'B', 'effectId': 'vinyl_flick',
            'parameters': {'speed_percent': 0}})
        require(status == 200, 'official scope changed extension-only VINYL placement')

        source_body = {'path': 'track', 'slot': 'A', 'effectId': 'beat_shift',
                       'parameters': {'official_type': 0, 'official_shift': -0.25}}
        require(request('/v1/native-fx/catalog-slot', 'POST', source_body)[0] == 200, 'source setup rejected')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'source start failed')
        def wait_source_status(expected):
            for _ in range(100):
                _, result = request('/v1/status')
                if result['nativeTracks'][0]['loopTransportStatus'] == expected:
                    return
                time.sleep(0.01)
            raise AssertionError(f'source status did not reach {expected}: {result["nativeTracks"][0]}')
        wait_source_status('waitingForLoop')
        require(request('/v1/transport/record', 'POST', {})[0] == 200, 'source recording test failed')
        wait_source_status('unsupportedRecording')
        require(request('/v1/transport/stop', 'POST', {})[0] == 200, 'source record stop failed')
        wait_source_status('waitingForPlayback')
        require(request('/v1/transport/play', 'POST', {})[0] == 200, 'source playback test failed')
        wait_source_status('active')
        require(request('/v1/transport/overdub-toggle', 'POST', {})[0] == 200, 'source overdub failed')
        wait_source_status('unsupportedOverdubbing')
        require(request('/v1/transport/overdub-toggle', 'POST', {})[0] == 200, 'source overdub exit failed')
        require(request('/v1/native-pitch/config', 'POST', {'enabled': True, 'trackId': 1})[0] == 200, 'source pitch conflict rejected')
        wait_source_status('unsupportedPitchProcessing')
        require(request('/v1/native-pitch/config', 'POST', {'enabled': False})[0] == 200, 'source pitch conflict clear rejected')
        wait_source_status('active')
        require(request('/v1/engine/stop', 'POST', {})[0] == 200, 'source stop failed')
        source_body.update(effectId='', parameters={})
        require(request('/v1/native-fx/catalog-slot', 'POST', source_body)[0] == 200, 'source clear failed')
        wait_source_status('disabled')

        for invalid in (-999, -20, -0.01, -3.14159, 50.25):
            status, _ = request('/v1/native-fx/catalog-slot', 'POST', {
                'path': 'input', 'slot': 'A', 'effectId': 'filter.lpf', 'parameters': {'official_rate': invalid}})
            require(status == 409, f'invalid tempo accepted: {invalid}, HTTP {status}: {_}')
        status, _ = request('/v1/native-fx/catalog-slot', 'POST', {
            'path': 'input', 'slot': 'A', 'effectId': 'ring_mod', 'parameters': {'official_mode': 1}})
        require(status == 409, 'unsupported MODE was accepted')
        print(f'Native official HTTP descriptors/live controls passed ({total} controls).')
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == '__main__':
    main()
