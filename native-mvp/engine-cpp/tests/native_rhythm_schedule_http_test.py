"""Rhythm-frame REC/STOP HTTP contract against the no-hardware host."""
import os
os.environ['WEBRC_NATIVE_BRIDGE_PORT'] = '17763'
import math
import subprocess
import sys
import time
import uuid
from native_bridge_http_simulation_test import (build_project_archive, request, request_project_archive, require)


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


def phase(status, track_id=2):
    value = status['nativeRhythm']['phase']
    require(value['available'] is True and value['snapshotStable'] is True, value)
    require(value['frameSchedulingAvailable'] is True, value)
    require(value['nextMeasureFrame'] > value['sampleFrame'], value)
    baseline = status['nativeLoopFrameScheduling']['requests'][track_id - 1]['requestedRevision']
    return {'trackId': track_id, 'action': 'record', 'absoluteFrame': value['nextMeasureFrame'],
        'phaseEpoch': value['epoch'], 'settingsRevision': status['nativeRhythm']['tempoAppliedRevision'],
        'intentId': uuid.uuid4().hex, 'hostIncarnationId': status['hostIncarnationId'],
        'expectedRevision': baseline}


def phase_has_headroom(status):
    value = status['nativeRhythm']['phase']
    return value['available'] is True and value['snapshotStable'] is True and \
        value['nextMeasureFrame'] - value['sampleFrame'] > 24000


def rhythm_measure_frame(origin_frame, ordinal, sample_rate=48000, bpm=99, meter_numerator=6, meter_denominator=8):
    steps_per_measure = meter_numerator * 16 // meter_denominator
    offset = ordinal * steps_per_measure * sample_rate * 15 / bpm
    return origin_frame + math.floor(offset + 0.5)


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
        code, rhythm = request('/v1/native-rhythm/config', 'POST', {'enabled': True, 'bpm': 99, 'patternIndex': 92})
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
        dub_code, dub_status = request('/v1/record/settings', 'POST', {'recAction': 'REC->DUB'})
        require(dub_code == 409 and 'loop sync' in dub_status.get('error', '').lower(),
            ('REC->DUB was accepted with LOOP SYNC enabled', dub_code, dub_status))
        direct_record_code, direct_record = request('/v1/transport/record?trackId=2', 'POST', {})
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
        record_request_status = request('/v1/status')[1]
        record_request = phase(record_request_status)
        record_start_measure_ordinal = record_request_status['nativeRhythm']['phase']['measureOrdinal'] + 1
        record_phase_origin_frame = record_request_status['nativeRhythm']['phase']['originFrame']
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
        for rhythm_change in [{'enabled': False}, {'bpm': 98}, {'patternIndex': 93}]:
            change_code, change_status = request('/v1/native-rhythm/config', 'POST', rhythm_change)
            require(change_code == 409 and 'phase cannot change' in change_status.get('error', '').lower(),
                ('Native Rhythm phase changed during synchronized recording', rhythm_change, change_code, change_status))
        reconfigure_code, reconfigure_status = request('/v1/config/apply', 'POST', config)
        require(reconfigure_code == 400 and 'loop sync recording' in reconfigure_status.get('error', '').lower(),
            ('audio reconfiguration was accepted during synchronized recording', reconfigure_code, reconfigure_status))
        engine_stop_code, engine_stop_status = request('/v1/engine/stop', 'POST', {})
        require(engine_stop_code == 409 and 'emergency stop' in engine_stop_status.get('error', '').lower(),
            ('engine stop was accepted during synchronized recording', engine_stop_code, engine_stop_status))
        stable_emergency_code, stable_emergency = request('/v1/transport/emergency-stop?trackId=2', 'POST', {})
        require(stable_emergency_code == 409 and 'measure stop' in stable_emergency.get('error', '').lower(),
            ('emergency STOP bypassed a stable measure phase', stable_emergency_code, stable_emergency))
        require(request('/v1/status')[1]['nativeTracks'][1]['state'] == 'Recording',
            'phase/config guards or rejected emergency STOP altered the active recording')
        direct_finish_code, direct_finish = request('/v1/transport/finish-record', 'POST', {'trackId': 2})
        require(direct_finish_code == 409 and 'scheduler' in direct_finish.get('error', '').lower(),
            ('direct REC completion bypassed Native LOOP SYNC scheduling', direct_finish_code, direct_finish))
        direct_stop_code, direct_stop = request('/v1/transport/stop?trackId=2', 'POST', {})
        require(direct_stop_code == 409 and 'measure' in direct_stop.get('error', '').lower(),
            ('direct STOP bypassed Native LOOP SYNC scheduling', direct_stop_code, direct_stop))
        require(request('/v1/status')[1]['nativeTracks'][1]['state'] == 'Recording', 'direct STOP changed the recording state')

        multi_measure_recording = until(lambda value:
            value['nativeRhythm']['phase']['measureOrdinal'] >= record_start_measure_ordinal + 10)
        require(multi_measure_recording['nativeTracks'][1]['state'] == 'Recording', multi_measure_recording)
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
        provenance = stopped['nativeTracks'][1]['phaseProvenance']
        require(provenance['verified'] is True and
            provenance['contentRevision'] == stopped['nativeTracks'][1]['contentRevision'] and
            provenance['pcmFrames'] == metadata['frameCount'] and
            provenance['stopFrame'] - provenance['startFrame'] == metadata['frameCount'] and
            provenance['firstMeasureFrames'] > 0 and provenance['measureCount'] == 11 and
            provenance['stopMeasureOrdinal'] - provenance['startMeasureOrdinal'] == provenance['measureCount'],
            ('scheduled PCM lacks exact Rhythm-phase provenance', provenance, metadata, stopped['nativeTracks'][1]))
        measure_intervals = [rhythm_measure_frame(record_phase_origin_frame, ordinal + 1) -
            rhythm_measure_frame(record_phase_origin_frame, ordinal)
            for ordinal in range(provenance['startMeasureOrdinal'], provenance['stopMeasureOrdinal'])]
        require(provenance['firstMeasureFrames'] == measure_intervals[0] and
            provenance['startFrame'] == rhythm_measure_frame(record_phase_origin_frame, provenance['startMeasureOrdinal']) and
            provenance['stopFrame'] == rhythm_measure_frame(record_phase_origin_frame, provenance['stopMeasureOrdinal']) and
            sum(measure_intervals) == metadata['frameCount'] and len(set(measure_intervals)) > 1,
            ('fractional-BPM cumulative bar boundaries do not prove the recorded PCM',
             provenance, measure_intervals, metadata))
        undo_code, undone = request('/v1/transport/undo?trackId=2', 'POST', {})
        require(undo_code == 200 and undone['nativeTracks'][1]['state'] == 'Empty' and
            undone['nativeTracks'][1]['phaseProvenance']['verified'] is False,
            ('undo did not clear the recording and its phase proof together', undo_code, undone))
        redo_code, redone = request('/v1/transport/redo?trackId=2', 'POST', {})
        redone_track = redone.get('nativeTracks', [{}, {}])[1]
        redone_provenance = redone_track.get('phaseProvenance', {})
        require(redo_code == 200 and redone_track.get('state') == 'Stopped' and
            redone_track.get('loopLengthSamples') == metadata['frameCount'] and
            redone_provenance.get('verified') is True and
            redone_provenance.get('contentRevision') == redone_track.get('contentRevision') and
            redone_provenance.get('pcmFrames') == metadata['frameCount'],
            ('redo did not restore PCM with its rebound phase proof', redo_code, redone))
        direct_play_code, direct_play = request('/v1/transport/play?trackId=2', 'POST', {})
        require(direct_play_code == 409 and 'scheduler' in direct_play.get('error', '').lower(),
            ('direct PLAY bypassed Native LOOP SYNC scheduling', direct_play_code, direct_play))
        set_callback_gate(True)
        play_request = phase(request('/v1/status')[1])
        play_request['action'] = 'play'
        code, accepted_play = request('/v1/transport/rhythm-schedule', 'POST', play_request)
        require(code == 200, ('verified synchronized PLAY was rejected', code, accepted_play))
        play_revision = accepted_play['nativeLoopFrameScheduling']['acceptedRevision']
        set_callback_gate(False)
        playing = until(lambda value: value['nativeLoopFrameScheduling']['requests'][1]['appliedRevision'] == play_revision
            and value['nativeTracks'][1]['state'] == 'Playing')
        playing_provenance = playing['nativeTracks'][1]['phaseProvenance']
        require(playing['nativeLoopFrameScheduling']['requests'][1]['appliedAbsoluteFrame'] ==
            play_request['absoluteFrame'] and playing_provenance['verified'] is True and
            playing_provenance['contentRevision'] == playing['nativeTracks'][1]['contentRevision'] and
            playing_provenance['pcmFrames'] == metadata['frameCount'], playing)
        direct_play_stop_code, direct_play_stop = request('/v1/transport/stop?trackId=2', 'POST', {})
        require(direct_play_stop_code == 200, ('stopping synchronized playback failed', direct_play_stop_code, direct_play_stop))
        stopped_after_play = until(lambda value: value['nativeTracks'][1]['state'] == 'Stopped')
        require(stopped_after_play['nativeTracks'][1]['loopLengthSamples'] == metadata['frameCount'] and
            stopped_after_play['nativeTracks'][1]['phaseProvenance']['verified'] is True, stopped_after_play)
        require(stopped_after_play['nativeTracks'][1]['history']['canUndo'] is True,
            ('scheduled Native recording did not publish its history receipt', stopped_after_play['nativeTracks'][1]['history']))
        clear_code, clear_accepted = request('/v1/transport/clear?trackId=2', 'POST', {})
        require(clear_code == 200, ('clear request was rejected', clear_code, clear_accepted))
        cleared = until(lambda value: value['nativeTracks'][1]['state'] == 'Empty' and
            value['nativeTracks'][1]['phaseProvenance']['verified'] is False)
        clear_undo_code, clear_undone = request('/v1/transport/undo?trackId=2', 'POST', {})
        clear_undo_track = clear_undone.get('nativeTracks', [{}, {}])[1]
        clear_undo_phase = clear_undo_track.get('phaseProvenance', {})
        require(clear_undo_code == 200 and clear_undo_track.get('state') == 'Stopped' and
            clear_undo_track.get('loopLengthSamples') == metadata['frameCount'] and
            clear_undo_phase.get('verified') is True and
            clear_undo_phase.get('contentRevision') == clear_undo_track.get('contentRevision'),
            ('clear undo failed to restore the exact PCM phase proof', clear_undo_code, clear_undone))
        clear_redo_code, clear_redone = request('/v1/transport/redo?trackId=2', 'POST', {})
        require(clear_redo_code == 200 and clear_redone['nativeTracks'][1]['state'] == 'Empty' and
            clear_redone['nativeTracks'][1]['phaseProvenance']['verified'] is False,
            ('clear redo retained PCM phase provenance after deleting the phrase', clear_redo_code, clear_redone))
        _, phrase_restored = request('/v1/transport/undo?trackId=2', 'POST', {})
        require(phrase_restored['nativeTracks'][1]['state'] == 'Stopped' and
            phrase_restored['nativeTracks'][1]['phaseProvenance']['verified'] is True,
            ('undo after clear redo did not restore the phrase proof for subsequent guards', phrase_restored))
        # A quantized REC request never replaces incumbent PCM implicitly.
        set_callback_gate(True)
        occupied_track_request = phase(request('/v1/status')[1])
        rejected_rec_code, rejected_rec_status = request('/v1/transport/rhythm-schedule', 'POST', occupied_track_request)
        set_callback_gate(False)
        require(rejected_rec_code in (400, 409) and 'empty track' in rejected_rec_status.get('error', '').lower(),
            ('scheduled REC did not reject a track that already owns committed PCM', rejected_rec_code, rejected_rec_status))
        metadata_after_rejected_rec = request('/v1/export/track-metadata?trackId=2')[1]
        current_track_revision = request('/v1/status')[1]['nativeTracks'][1]['contentRevision']
        require(metadata_after_rejected_rec['frameCount'] == metadata['frameCount'] and
            metadata_after_rejected_rec['contentRevision'] == current_track_revision, metadata_after_rejected_rec)
        require(stopped['nativeRecordPlay']['quantizeAvailable'] is True and
            stopped['nativeLoopFrameScheduling']['available'] is True and
            stopped['nativeRecordPlay']['quantize'] == 'MEASURE' and
            stopped['nativeMemory']['loopSync'][1] is True, stopped)

        # Exercise the explicit callback-acknowledged emergency endpoint. It
        # retains every frame captured before the callback applies STOP.
        code, track_three_sync = request('/v1/record/loop-sync', 'POST', {'trackId': 3, 'enabled': True})
        require(code == 200 and track_three_sync['nativeMemory']['loopSync'][2] is True, track_three_sync)
        set_callback_gate(True)
        emergency_record = phase(request('/v1/status')[1], 3)
        code, emergency_accepted = request('/v1/transport/rhythm-schedule', 'POST', emergency_record)
        require(code == 200, emergency_accepted)
        emergency_record_revision = emergency_accepted['nativeLoopFrameScheduling']['acceptedRevision']
        set_callback_gate(False)
        emergency_recording = until(lambda value:
            value['nativeLoopFrameScheduling']['requests'][2]['appliedRevision'] == emergency_record_revision
            and value['nativeTracks'][2]['state'] == 'Recording')
        set_callback_gate(True)
        phase_loss_code, phase_loss = request('/v1/test/simulation/rhythm-phase-unavailable', 'POST', {})
        require(phase_loss_code == 200 and phase_loss.get('phaseAvailable') is False,
            ('simulation did not inject explicit phase loss before emergency STOP', phase_loss_code, phase_loss))
        phase_lost_status = request('/v1/status')[1]
        require(phase_lost_status['nativeRhythm']['phase']['snapshotStable'] is True and
            phase_lost_status['nativeRhythm']['phase']['available'] is False,
            ('emergency STOP was not tested against a stable unavailable phase', phase_lost_status))
        emergency_code, emergency_status = request('/v1/transport/emergency-stop?trackId=3', 'POST', {})
        require(emergency_code == 200, emergency_status)
        emergency_stop_revision = emergency_status['nativeRecordPlay']['acceptedStopRequestRevision']
        recovered_code, recovered = request('/v1/test/simulation/rhythm-phase-available', 'POST', {})
        require(recovered_code == 200 and recovered.get('phaseAvailable') is True,
            ('simulation did not recover phase before emergency STOP callback application', recovered_code, recovered))
        set_callback_gate(False)
        phase_recovered_stop = until(lambda value:
            value['nativeRecordPlay']['stopApplied'][2] == emergency_stop_revision)
        require(phase_recovered_stop['nativeRecordPlay']['stopCancelled'][2] == emergency_stop_revision and
            phase_recovered_stop['nativeRecordPlay']['stopCommittedRevision'][2] != emergency_stop_revision and
            phase_recovered_stop['nativeTracks'][2]['state'] == 'Recording',
            ('emergency STOP ignored the recovered phase token or changed track PCM/state', phase_recovered_stop))

        set_callback_gate(True)
        phase_loss_code, phase_loss = request('/v1/test/simulation/rhythm-phase-unavailable', 'POST', {})
        require(phase_loss_code == 200 and phase_loss.get('phaseAvailable') is False,
            ('simulation did not re-inject phase loss for successful emergency STOP', phase_loss_code, phase_loss))
        emergency_code, emergency_status = request('/v1/transport/emergency-stop?trackId=3', 'POST', {})
        require(emergency_code == 200, emergency_status)
        emergency_stop_revision = emergency_status['nativeRecordPlay']['acceptedStopRequestRevision']
        set_callback_gate(False)
        emergency_stopped = until(lambda value:
            value['nativeRecordPlay']['stopApplied'][2] == emergency_stop_revision
            and value['nativeTracks'][2]['state'] == 'Stopped')
        require(emergency_stopped['nativeTracks'][2]['loopLengthSamples'] > 0 and
            emergency_stopped['nativeRecordPlay']['stopCommittedRevision'][2] == emergency_stop_revision,
            emergency_stopped)

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

        # Importing an ordinary project replaces a previously phase-proven take
        # with unproven PCM. Imported PCM must never inherit the old proof.
        before_import = request('/v1/status')[1]
        import_archive = build_project_archive([None,
            {'channels': 2, 'samples': [0.25, -0.25, 0.5, -0.5]}, None, None, None],
            name='unproven import', bpm=99.0)
        import_code, import_candidate = request_project_archive(
            f"/v1/project/import?expectedContentRevision={before_import['projectContentRevision']}",
            'POST', import_archive, 'application/octet-stream')
        require(import_code == 202, ('ordinary project import was rejected', import_code, import_candidate))
        import_generation = import_candidate['generation']
        def import_is_committed(_):
            state_code, state = request(f'/v1/project/import/status?generation={import_generation}')
            require(state_code == 200, state)
            return state['state'] == 'committed'
        until(import_is_committed)
        import_state_code, import_state = request(f'/v1/project/import/status?generation={import_generation}')
        require(import_state_code == 200 and import_state['state'] == 'committed', import_state)
        imported = until(lambda value: value['projectContentRevision'] > before_import['projectContentRevision'] and
            value['nativeTracks'][1]['state'] == 'Stopped' and value['nativeTracks'][1]['loopLengthSamples'] == 2 and
            value['nativeTracks'][1]['phaseProvenance']['verified'] is False)
        require(imported['nativeMemory']['loopSync'][1] is True, imported['nativeMemory'])
        play_after_import = phase(imported)
        play_after_import['action'] = 'play'
        import_play_code, import_play = request('/v1/transport/rhythm-schedule', 'POST', play_after_import)
        require(import_play_code == 409 and 'provenance' in import_play.get('error', '').lower(),
            ('imported PCM inherited a synchronized PLAY phase proof', import_play_code, import_play))
        print('Native Rhythm LOOP SYNC HTTP: fractional-boundary provenance, synchronized PLAY, Clear/Undo/Redo, import invalidation, phase-change guards, emergency PCM-preserving STOP')
    finally:
        try:
            request('/v1/test/simulation/callback-gate', 'POST', {'paused': False})
        except Exception:
            pass
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
