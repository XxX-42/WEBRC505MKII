"""End-to-end simulation test for host-bound Native ALL transport batches."""
import os
os.environ['WEBRC_NATIVE_BRIDGE_PORT'] = '17764'
import subprocess
import sys
import time
import uuid
from native_bridge_http_simulation_test import build_project_archive, request, request_project_archive, require


def until(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        code, latest = request('/v1/status')
        require(code == 200, latest)
        if predicate(latest):
            return latest
        time.sleep(.01)
    raise AssertionError(('Native batch status timed out', latest))


def gate(paused):
    code, status = request('/v1/test/simulation/callback-gate', 'POST', {'paused': paused})
    require(code == 200 and status.get('paused') is paused, ('callback gate failed', status))
    if paused:
        require(status.get('callbackParked') is True, status)


def make_batch(status, action, intent_id=None):
    scheduling = status['nativeLoopFrameScheduling']
    tracks = status['nativeTracks']
    states = [track['stateCode'] for track in tracks]
    eligible = [index for index, track in enumerate(tracks) if
        (action == 'play' and track['state'] == 'Stopped' and track['loopLengthSamples'] > 0) or
        (action == 'stop' and track['state'] in ('Recording', 'Playing', 'Overdubbing'))]
    mask = sum(1 << index for index in eligible)
    require(mask.bit_count() >= 2, ('expected at least two eligible tracks', action, tracks))
    if any(status['nativeMemory']['loopSync'][index] for index in eligible):
        raise AssertionError(('batch unexpectedly includes LOOP SYNC', eligible))
    bpm = [0.0] * 5
    tempo_revision = [0] * 5
    provenance_mask = 0
    for index in eligible:
        if action == 'stop' and tracks[index]['state'] == 'Recording':
            token = status['nativeRecordingTempoTokens'][index]
            require(token['valid'] is True and token['bpm'] is not None, ('missing recording token', token))
            bpm[index] = token['bpm']
            tempo_revision[index] = token['revision']
            provenance_mask |= 1 << index
    frame = status['nativeSampleFrame']
    # The headless callback pumps faster than wall-clock audio. Leave enough
    # frame headroom for HTTP round trips and a deliberately paused callback.
    target = frame + max(status['bufferFrames'] * 4, status['sampleRate'])
    return {'hostIncarnationId': status['hostIncarnationId'], 'intentId': intent_id or uuid.uuid4().hex,
        'action': action, 'expectedSampleFrame': frame, 'absoluteFrame': target, 'trackMask': mask,
        'expectedStates': states,
        'expectedScheduleRevisions': [item['requestedRevision'] for item in scheduling['requests']],
        'expectedStopRevisions': status['nativeRecordPlay']['stopRequested'],
        'provenanceBpm': bpm, 'provenanceRevisions': tempo_revision, 'provenanceMask': provenance_mask}


def submit(body):
    code, status = request('/v1/transport/batch-schedule', 'POST', body)
    require(code == 200, ('batch was not accepted', code, status))
    info = status['nativeLoopFrameScheduling']
    require(info['acceptedBatchMask'] == body['trackMask'] and info['acceptedBatchIntentId'] == body['intentId'], info)
    revisions = info['acceptedBatchRevisions']
    return {'hostIncarnationId': body['hostIncarnationId'], 'batchId': info['acceptedBatchId'],
        'trackMask': body['trackMask'], 'intentId': body['intentId'], 'revisions': revisions,
        'absoluteFrame': body['absoluteFrame']}


def receipt(identity):
    code, value = request('/v1/transport/batch-status', 'POST', {key: identity[key] for key in
        ('hostIncarnationId', 'batchId', 'trackMask', 'intentId', 'revisions')})
    require(code == 200, ('exact batch receipt rejected', code, value))
    return value


def wait_state(identity, state, timeout=10):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = receipt(identity)
        if latest['state'] == state:
            return latest
        time.sleep(.01)
    current = request('/v1/status')[1]
    raise AssertionError(('batch lifecycle timed out', state, latest,
        current.get('nativeSampleFrame'), current.get('nativeLoopFrameScheduling', {}).get('requests')))


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(('simulation host exited', process.returncode))
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)
        code, initial = request('/v1/status')
        require(code == 200 and initial['nativeLoopFrameScheduling']['batchTransportAvailable'] is True, initial)

        # Strict malformed requests never publish any schedule revision.
        baseline = [item['requestedRevision'] for item in initial['nativeLoopFrameScheduling']['requests']]
        malformed = {'hostIncarnationId': initial['hostIncarnationId'], 'intentId': uuid.uuid4().hex,
            'action': 'record', 'expectedSampleFrame': 0, 'absoluteFrame': 1, 'trackMask': 3,
            'expectedStates': [0] * 5, 'expectedScheduleRevisions': [0] * 5, 'expectedStopRevisions': [0] * 5,
            'provenanceBpm': [0.0] * 5, 'provenanceRevisions': [0] * 5, 'provenanceMask': 0}
        code, rejected = request('/v1/transport/batch-schedule', 'POST', malformed)
        require(code == 400, ('Record batch was not rejected', code, rejected))
        require([item['requestedRevision'] for item in request('/v1/status')[1]['nativeLoopFrameScheduling']['requests']] == baseline,
            'malformed batch changed schedule revisions')

        config = {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1', 'outputDeviceId': 'WASAPI:1',
            'sampleRate': 48000, 'bufferFrames': 256, 'monitoringEnabled': False}
        require(request('/v1/config/apply', 'POST', config)[0] == 200, 'engine config failed')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'engine start failed')
        for track_id, token_revision in ((1, 71), (2, 93)):
            code, response = request(f'/v1/transport/record?trackId={track_id}&tempoBpm=120&tempoRevision={token_revision}', 'POST', {})
            require(code == 200, ('record request rejected', track_id, response))
        recording = until(lambda value: all(value['nativeTracks'][index]['state'] == 'Recording' and
            value['nativeRecordingTempoTokens'][index]['valid'] for index in (0, 1)))

        stop_identity = submit(make_batch(recording, 'stop'))
        stopped_receipt = wait_state(stop_identity, 5)
        require(len(stopped_receipt['members']) == 2 and all(
            member['appliedRevision'] == member['revision'] and member['appliedAbsoluteFrame'] == stop_identity['absoluteFrame']
            for member in stopped_receipt['members']), stopped_receipt)
        stopped = until(lambda value: all(value['nativeTracks'][index]['state'] == 'Stopped' and
            value['nativeRecordPlay']['stopCommittedRevision'][index] == value['nativeRecordPlay']['stopRequested'][index]
            for index in (0, 1)))
        for index, token_revision in ((0, 71), (1, 93)):
            member = next(item for item in stopped_receipt['members'] if item['trackId'] == index + 1)
            code, confirmed = request('/v1/transport/record-tempo/confirm', 'POST', {
                'trackId': index + 1, 'expectedContentRevision': stopped['nativeTracks'][index]['contentRevision'],
                'tempoBpm': 120, 'tempoRevision': token_revision, 'stopRevision': member['stopRevision']})
            require(code == 200, ('take tempo confirmation rejected', index + 1, confirmed))
            until(lambda value, i=index: value['nativeRecordTempoProvenance']['acceptedRevision'][i] > 0)
        for track_id in (1, 2):
            code, metadata = request(f'/v1/export/track-metadata?trackId={track_id}')
            require(code == 200 and metadata['originalTempoBpm'] == 120, ('original tempo lost', track_id, metadata))

        playing_identity = submit(make_batch(stopped, 'play'))
        playing_receipt = wait_state(playing_identity, 5)
        playing = until(lambda value: all(value['nativeTracks'][index]['state'] == 'Playing' for index in (0, 1)))
        require(all(item['appliedAbsoluteFrame'] == playing_identity['absoluteFrame'] for item in playing_receipt['members']), playing_receipt)

        # Freeze the callback, accept STOP for tracks 1/2, then a second client
        # activates omitted Track 3. Due-time fencing must fault the whole batch.
        gate(True)
        raced_identity = submit(make_batch(playing, 'stop'))
        code, third_record = request('/v1/transport/record?trackId=3&tempoBpm=120&tempoRevision=117', 'POST', {})
        require(code == 200, ('cross-client Track 3 REC rejected', code, third_record))
        gate(False)
        raced_receipt = wait_state(raced_identity, 6)
        # A later batch may overwrite live per-track scheduler slots. The
        # terminal PLAY receipt must remain addressable by its exact identity.
        archived_play_receipt = receipt(playing_identity)
        require(archived_play_receipt['state'] == 5 and all(
            member['appliedRevision'] == member['revision'] and
            member['appliedAbsoluteFrame'] == playing_identity['absoluteFrame']
            for member in archived_play_receipt['members']), archived_play_receipt)
        raced = until(lambda value: value['nativeTracks'][0]['state'] == 'Playing' and
            value['nativeTracks'][1]['state'] == 'Playing' and value['nativeTracks'][2]['state'] == 'Recording')
        require(all(member['appliedRevision'] != member['revision'] for member in raced_receipt['members']), raced_receipt)

        all_stopped_identity = submit(make_batch(raced, 'stop'))
        all_stopped_receipt = wait_state(all_stopped_identity, 5)
        all_stopped = until(lambda value: all(value['nativeTracks'][index]['state'] == 'Stopped' for index in (0, 1, 2)))
        recording_member = next(item for item in all_stopped_receipt['members'] if item['trackId'] == 3)
        code, confirmed = request('/v1/transport/record-tempo/confirm', 'POST', {
            'trackId': 3, 'expectedContentRevision': all_stopped['nativeTracks'][2]['contentRevision'],
            'tempoBpm': 120, 'tempoRevision': 117, 'stopRevision': recording_member['stopRevision']})
        require(code == 200, ('Track 3 provenance confirmation rejected', code, confirmed))
        all_stopped = until(lambda value: value['nativeRecordTempoProvenance']['acceptedRevision'][2] > 0)

        # Cancellation uses the exact identity and is linearized before callback dispatch.
        gate(True)
        cancellable = submit(make_batch(all_stopped, 'play'))
        wrong = dict(cancellable, intentId='1' * 32)
        wrong_code, wrong_response = request('/v1/transport/batch-cancel', 'POST', {key: wrong[key] for key in
            ('hostIncarnationId', 'batchId', 'trackMask', 'intentId', 'revisions')})
        require(wrong_code == 409, ('wrong batch intent cancelled another request', wrong_code, wrong_response))
        code, cancel_status = request('/v1/transport/batch-cancel', 'POST', {key: cancellable[key] for key in
            ('hostIncarnationId', 'batchId', 'trackMask', 'intentId', 'revisions')})
        require(code == 200, ('exact batch cancel rejected', code, cancel_status))
        gate(False)
        cancelled = wait_state(cancellable, 4)
        require(all(item['cancelledRevision'] == item['revision'] for item in cancelled['members']), cancelled)
        final = request('/v1/status')[1]
        require(all(final['nativeTracks'][index]['state'] == 'Stopped' for index in (0, 1, 2)), final)

        stale = dict(cancellable, hostIncarnationId='0' * 32)
        require(request('/v1/transport/batch-status', 'POST', {key: stale[key] for key in
            ('hostIncarnationId', 'batchId', 'trackMask', 'intentId', 'revisions')})[0] == 409,
            'host-incarnation mismatch was not fenced')

        # Four-frame PCM finishes inside the very callback which starts it.
        # Import exact short loops so this exercises the HTTP receipt end to end.
        archive = build_project_archive([{'channels': 1, 'samples': [0.1] * 4},
            {'channels': 1, 'samples': [0.1] * 4}, None, None, None])
        revision = final['projectContentRevision']
        code, imported = request_project_archive(f'/v1/project/import?expectedContentRevision={revision}',
            'POST', archive, 'application/octet-stream')
        require(code == 202, ('short loop import rejected', code, imported))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            code, import_status = request_project_archive(
                f"/v1/project/import/status?generation={imported['generation']}", 'GET')
            if code == 200 and import_status.get('state') == 'committed':
                break
            time.sleep(.01)
        else:
            raise AssertionError(('short loop import did not commit', import_status))
        for track_id in (1, 2):
            current = request('/v1/status')[1]
            config = dict(current['nativeMemory']['loopTransports'][track_id - 1])
            config.update(trackId=track_id, mode='off', oneShot=True)
            code, configured = request('/v1/native-loop-transport/config', 'POST', config)
            require(code == 200, ('short loop one shot config rejected', code, configured))
        short_stopped = until(lambda value: all(value['nativeTracks'][i]['state'] == 'Stopped' and
            value['nativeTracks'][i]['loopLengthSamples'] == 4 and
            value['nativeTracks'][i]['loopTransportAppliedOneShot'] is True for i in (0, 1)))
        short_identity = submit(make_batch(short_stopped, 'play'))
        short_receipt = wait_state(short_identity, 5)
        short_after = request('/v1/status')[1]
        require(all(short_after['nativeTracks'][i]['state'] == 'Stopped' for i in (0, 1)), short_after)
        require(all(member['appliedAbsoluteFrame'] == short_identity['absoluteFrame']
            for member in short_receipt['members']), short_receipt)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == '__main__':
    main()
