"""Validate provenance/nullability through the device-free HTTP host, never hardware."""
import os
import subprocess
import sys
import time
os.environ['WEBRC_NATIVE_BRIDGE_PORT']='17761'
from native_bridge_http_simulation_test import request,require

def main():
    process=subprocess.Popen([sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                if request('/health')[0]==200:break
            except Exception:time.sleep(.05)
        code,status=request('/v1/status');require(code==200,status)
        t=status['callbackTelemetry']
        require(t['sourceKind']=='NO_CALLBACKS' and t['callbackCount'] is None,t)
        require(t['duration']['samples'] is None and t['duration']['histogram'] is None,t)
        require(all(t['driver'][key] is None for key in ('inputOverflow','outputUnderflow','resetCount','globalStatistics')),t)
        code,status=request('/v1/config/apply','POST',{'backend':'WASAPI','inputDeviceId':'WASAPI:1',
            'outputDeviceId':'WASAPI:1','sampleRate':48000,'bufferFrames':128,'monitoringEnabled':False})
        require(code==200,status)
        code,status=request('/v1/engine/start','POST',{});require(code==200,status)
        time.sleep(.05)
        code,status=request('/v1/status');require(code==200,status)
        t=status['callbackTelemetry']
        require(t['sourceKind']=='NO_HARDWARE_SIMULATION' and t['observed'] and t['callbackCount']>0,t)
        require(t['hardwareCallbackCount'] is None and t['driver']['inputOverflow'] is None and t['driver']['outputUnderflow'] is None,t)
        require(t['statusFlags']['inputOverflow']==0 and t['statusFlags']['outputUnderflow']==0,t)
        require(t['duration']['samples']>0 and sum(t['duration']['histogram'])==t['duration']['samples'],t)
        require(t['duration']['binWidthNs']==50000 and len(t['duration']['histogram'])==512,t)
        require(t['software']['runtimeResetCount']>0 and t['driver']['resetCount'] is None,t)
        before=t['callbackCount']
        request('/v1/engine/stop','POST',{})
        _,stopped=request('/v1/status');require(stopped['callbackTelemetry']['callbackCount']>=before,stopped)
        print('PASS: simulation callback telemetry is cause-separated, observed and explicitly not hardware')
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':main()
