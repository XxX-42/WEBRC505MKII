"""Native Bounce settings/readback contract against the no-hardware host."""
import os
os.environ['WEBRC_NATIVE_BRIDGE_PORT'] = '17762'
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
    raise AssertionError(('Native Bounce callback ACK timed out', status))


def main():
    process = subprocess.Popen([sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if request('/health')[0] == 200:
                    break
            except Exception:
                time.sleep(.05)
        code, status = request('/v1/status')
        require(code == 200 and status['nativeBounce']['hardwareFxPlacementVerified'] is False, status)
        desired = {'bounceSw': True, 'bounceIn': [True, False, True, False, False],
            'bounceTrack': [False, True, True, False, True]}
        code, accepted = request('/v1/native-bounce/settings', 'POST', desired)
        require(code == 200, accepted)
        require(accepted['nativeBounce']['acceptedRevision'] == accepted['nativeBounce']['requestedRevision'], accepted)
        ack = until(lambda value: value['nativeBounce']['requestedRevision'] == value['nativeBounce']['appliedRevision'])
        require(ack['nativeBounce']['bounceSw'] is True and ack['nativeBounce']['bounceIn'] == desired['bounceIn'], ack)
        require(ack['nativeMemory']['bounce']['bounceTrack'] == desired['bounceTrack'], ack['nativeMemory'])
        for invalid in [dict(desired, bounceIn=[True]), dict(desired, extra=True), dict(desired, bounceTrack=[True, 0, False, False, False])]:
            require(request('/v1/native-bounce/settings', 'POST', invalid)[0] == 400, invalid)
        config = {'backend': 'WASAPI', 'inputDeviceId': 'WASAPI:1', 'outputDeviceId': 'WASAPI:1',
            'sampleRate': 48000, 'bufferFrames': 64, 'monitoringEnabled': False}
        require(request('/v1/config/apply', 'POST', config)[0] == 200, 'config failed')
        require(request('/v1/engine/start', 'POST', {})[0] == 200, 'start failed')
        require(request('/v1/transport/record', 'POST', {'trackId': 1})[0] == 200, 'record failed')
        until(lambda value: value['nativeTracks'][0]['state'] == 'Recording')
        require(request('/v1/native-bounce/settings', 'POST', desired)[0] == 409, 'Bounce change accepted during recording')
        require(request('/v1/transport/stop', 'POST', {'trackId': 1})[0] == 200, 'stop failed')
        print('Native Bounce HTTP: validated five-track settings, callback-applied readback, Memory exposure and recording guard')
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == '__main__':
    main()
