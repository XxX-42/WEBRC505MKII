"""Rhythm-frame REC/STOP HTTP contract against the no-hardware host."""
import os
os.environ['WEBRC_NATIVE_BRIDGE_PORT'] = '17763'
import subprocess
import sys
import time
import uuid
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
    require(value['frameSchedulingAvailable'] is True, value)
    require(value['nextMeasureFrame'] > value['sampleFrame'], value)
    baseline = status['nativeLoopFrameScheduling']['requests'][1]['requestedRevision']
    return {'trackId': 2, 'action': 'record', 'absoluteFrame': value['nextMeasureFrame'],
        'phaseEpoch': value['epoch'], 'settingsRevision': status['nativeRhythm']['tempoAppliedRevision'],
        'intentId': uuid.uuid4().hex, 'hostIncarnationId': status['hostIncarnationId'],
        'expectedRevision': baseline}


def phase_has_headroom(status):
    value = status['nativeRhythm']['phase']
    return value['available'] is True and value['snapshotStable'] is True and \
        value['nextMeasureFrame'] - value['sampleFrame'] > 24000


def set_callback_gate(paused):
    code, status = request('/v1/test/simulation/callback-gate', 'POST', {'paused': paused})
    require(code == 200 and status.get('paused') is paused,
        ('simulation callback gate update failed', paused, status))
    if paused:
        require(status.get('callbackParked') is True, status)


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(('Native bridge simulation host exited during startup', process.returncode))
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)

        code, initial = request('/v1/status')
        require(code == 200, initial)
        # The user feature is available only for the running Native Rhythm
        # phase source and becomes false again when that source stops.
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
        for body in [{}, {'trackId': 0, 'revision': 1, 'hostIncarnationId': '0' * 32},
                     {'trackId': 1, 'revision': 0, 'hostIncarnationId': '0' * 32},
                     {'trackId': 1, 'revision': 1, 'hostIncarnationId': '0' * 32, 'intentId': '1' * 32, 'extra': True}]:
            require(request('/v1/transport/rhythm-schedule/cancel', 'POST', body)[0] == 400,
                ('invalid cancel request accepted', body))

        config = {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1', 'outputDeviceId': 'WASAPI:1',
            'sampleRate': 48000, 'bufferFrames': 4096, 'monitoringEnabled': False}
        require(request('/v1/config/apply', 'POST', config)[0] == 200, 'engine config failed')
        code, rhythm = request('/v1/native-rhythm/config', 'POST', {'enabled': True, 'bpm': 300, 'patternIndex': 92})
        require(code == 200, rhythm)
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'engine start failed')
        running = until(phase_has_headroom)
        require(running['nativeRecordPlay']['quantizeAvailable'] is True and
            running['nativeLoopFrameScheduling']['available'] is True, running)
        code, quantize_status = request('/v1/record/settings', 'POST', {'quantize': 'MEASURE'})
        require(code == 200 and quantize_status['nativeRecordPlay']['quantize'] == 'MEASURE', quantize_status)
        code, sync_status = request('/v1/record/loop-sync', 'POST', {'trackId': 2, 'enabled': True})
        require(code == 200 and sync_status['nativeMemory']['loopSync'][1] is True, sync_status)
        off_code, off_status = request('/v1/record/settings', 'POST', {'quantize': 'OFF'})
        require(off_code == 409 and 'loop sync' in off_status.get('error', '').lower(),
            ('REC QUANTIZE OFF was accepted with LOOP SYNC enabled', off_code, off_status))
        direct_record_code, direct_record = request('/v1/transport/record', 'POST', {'trackId': 2})
        require(direct_record_code == 409 and 'scheduler' in direct_record.get('error', '').lower(),
            ('direct REC bypassed Native LOOP SYNC scheduling', direct_record_code, direct_record))
        set_callback_gate(True)
        first_status = request('/v1/status')[1]
        first = phase(first_status)
        stale_host = dict(first, hostIncarnationId='0' * 32)
        require(request('/v1/transport/rhythm-schedule', 'POST', stale_host)[0] == 409,
            'schedule POST crossed the host incarnation fence')
        stale_revision = dict(first, expectedRevision=first['expectedRevision'] + 1)
        require(request('/v1/transport/rhythm-schedule', 'POST', stale_revision)[0] == 409,
            'schedule POST crossed the request revision baseline')
        code, queued = request('/v1/transport/rhythm-schedule', 'POST', first)
        require(code == 200, queued)
        revision = queued['nativeLoopFrameScheduling']['acceptedRevision']
        require(queued['nativeLoopFrameScheduling']['acceptedTrackId'] == 2 and revision > 0, queued)
        require(queued['nativeLoopFrameScheduling']['requests'][1]['requestedIntentId'] == first['intentId'], queued)
        require(request('/v1/transport/rhythm-schedule', 'POST', first)[0] == 409,
            'second pending schedule for the same track was accepted')
        stale_host_cancel = request('/v1/transport/rhythm-schedule/cancel', 'POST', {
            'trackId': 2, 'revision': revision, 'hostIncarnationId': '0' * 32,
            'intentId': first['intentId']})
        require(stale_host_cancel[0] == 409, ('cancel crossed host restart fence', stale_host_cancel))
        stale_intent_cancel = request('/v1/transport/rhythm-schedule/cancel', 'POST', {
            'trackId': 2, 'revision': revision, 'hostIncarnationId': first_status['hostIncarnationId'],
            'intentId': 'f' * 32})
        require(stale_intent_cancel[0] == 409, ('cancel accepted a different intent ID', stale_intent_cancel))
        cancel_code, cancel_accepted = request('/v1/transport/rhythm-schedule/cancel', 'POST', {
            'trackId': 2, 'revision': revision, 'hostIncarnationId': first_status['hostIncarnationId'],
            'intentId': first['intentId']})
        require(cancel_code == 200, ('cancel request was not accepted', cancel_accepted))
        set_callback_gate(False)
        cancelled_status = until(lambda value:
            value['nativeLoopFrameScheduling']['requests'][1]['cancelledRevision'] == revision)
        require(cancelled_status['nativeTracks'][1]['state'] == 'Empty', cancelled_status)

        # Park the fake callback at a complete-block boundary before each
        # future measure request. This makes cancellation and frame ACK ordering
        # deterministic without pretending the simulation cadence is hardware.
        set_callback_gate(True)
        record_request = phase(request('/v1/status')[1])
        code, accepted = request('/v1/transport/rhythm-schedule', 'POST', record_request)
        require(code == 200, accepted)
        record_revision = accepted['nativeLoopFrameScheduling']['acceptedRevision']
        require(accepted['nativeLoopFrameScheduling']['requests'][1]['requestedIntentId'] == record_request['intentId'], accepted)
        pending_finish_code, pending_finish = request('/v1/transport/finish-record', 'POST', {'trackId': 2})
        require(pending_finish_code == 409 and 'pending' in pending_finish.get('error', '').lower(),
            ('REC completion raced a pending synchronized start', pending_finish_code, pending_finish))
        set_callback_gate(False)
        recorded = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == record_revision
            and value['nativeTracks'][1]['state'] == 'Recording')
        require(recorded['nativeLoopFrameScheduling']['requests'][1]['appliedAbsoluteFrame'] ==
            record_request['absoluteFrame'], recorded)
        direct_finish_code, direct_finish = request('/v1/transport/finish-record', 'POST', {'trackId': 2})
        require(direct_finish_code == 409 and 'scheduler' in direct_finish.get('error', '').lower(),
            ('direct REC completion bypassed Native LOOP SYNC scheduling', direct_finish_code, direct_finish))
        direct_stop_code, direct_stop = request('/v1/transport/stop', 'POST', {'trackId': 2})
        require(direct_stop_code == 409 and 'measure' in direct_stop.get('error', '').lower(),
            ('direct STOP bypassed Native LOOP SYNC scheduling', direct_stop_code, direct_stop))
        require(request('/v1/status')[1]['nativeTracks'][1]['state'] == 'Recording', 'direct STOP changed the recording state')

        set_callback_gate(True)
        stop_request = phase(request('/v1/status')[1])
        stop_request['action'] = 'stop'
        code, accepted_stop = request('/v1/transport/rhythm-schedule', 'POST', stop_request)
        require(code == 200, accepted_stop)
        stop_revision = accepted_stop['nativeLoopFrameScheduling']['acceptedRevision']
        require(accepted_stop['nativeLoopFrameScheduling']['requests'][1]['requestedIntentId'] == stop_request['intentId'], accepted_stop)
        set_callback_gate(False)
        stopped = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == stop_revision
            and value['nativeTracks'][1]['state'] == 'Stopped')
        require(stopped['nativeLoopFrameScheduling']['requests'][1]['appliedAbsoluteFrame'] ==
            stop_request['absoluteFrame'], stopped)
        metadata_code, metadata = request('/v1/export/track-metadata?trackId=2')
        require(metadata_code == 200 and metadata['frameCount'] ==
            stop_request['absoluteFrame'] - record_request['absoluteFrame'], metadata)
        direct_play_code, direct_play = request('/v1/transport/play', 'POST', {'trackId': 2})
        require(direct_play_code == 409 and 'scheduler' in direct_play.get('error', '').lower(),
            ('direct PLAY bypassed Native LOOP SYNC scheduling', direct_play_code, direct_play))
        set_callback_gate(True)
        play_request = phase(request('/v1/status')[1])
        play_request['action'] = 'play'
        code, accepted_play = request('/v1/transport/rhythm-schedule', 'POST', play_request)
        require(code == 200, accepted_play)
        play_revision = accepted_play['nativeLoopFrameScheduling']['acceptedRevision']
        set_callback_gate(False)
        playing = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == play_revision
            and value['nativeTracks'][1]['state'] == 'Playing')
        require(playing['nativeLoopFrameScheduling']['requests'][1]['appliedAbsoluteFrame'] ==
            play_request['absoluteFrame'], playing)
        require(playing['nativeTracks'][1]['loopLengthSamples'] == metadata['frameCount'], playing)
        # A quantized REC request never replaces incumbent PCM implicitly.
        set_callback_gate(True)
        occupied_track_request = phase(request('/v1/status')[1])
        rejected_rec_code, rejected_rec_status = request('/v1/transport/rhythm-schedule', 'POST', occupied_track_request)
        set_callback_gate(False)
        require(rejected_rec_code in (400, 409) and 'empty track' in rejected_rec_status.get('error', '').lower(),
            ('scheduled REC did not reject a track that already owns committed PCM', rejected_rec_code, rejected_rec_status))
        metadata_after_rejected_rec = request('/v1/export/track-metadata?trackId=2')[1]
        require(metadata_after_rejected_rec['frameCount'] == metadata['frameCount'] and
            metadata_after_rejected_rec['contentRevision'] == metadata['contentRevision'], metadata_after_rejected_rec)
        require(stopped['nativeRecordPlay']['quantizeAvailable'] is True and
            stopped['nativeLoopFrameScheduling']['available'] is True and
            stopped['nativeRecordPlay']['quantize'] == 'MEASURE' and
            stopped['nativeMemory']['loopSync'][1] is True, stopped)

        # A stopped stream must clear the simulation-only gate so restarting
        # the same host/RtAudio instance does not inherit a parked callback.
        set_callback_gate(True)
        code, stopped_engine = request('/v1/engine/stop', 'POST', {})
        require(code == 200 and stopped_engine['engineRunning'] is False, stopped_engine)
        code, gate_status = request('/v1/test/simulation/callback-gate')
        require(code == 200 and gate_status['paused'] is False and gate_status['callbackParked'] is False,
            ('simulation callback gate survived stream stop', gate_status))
        code, restarted_engine = request('/v1/engine/start', 'POST', {})
        require(code == 200 and restarted_engine['engineRunning'] is True, restarted_engine)
        restarted = until(lambda value: value['engineRunning'] and value['nativeRhythm']['phase']['available'] and
            value['nativeRhythm']['phase']['sampleFrame'] > 0)
        code, gate_status = request('/v1/test/simulation/callback-gate')
        require(code == 200 and gate_status['paused'] is False and gate_status['callbackParked'] is False,
            ('simulation callback did not resume after restart', gate_status))
        print('Native Rhythm LOOP SYNC HTTP: settings ACK, exact callback frame ACK, PCM frame length, incumbent PCM protection')
    finally:
        try:
            request('/v1/test/simulation/callback-gate', 'POST', {'paused': False})
        except Exception:
            pass
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
