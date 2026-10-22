#!/usr/bin/env python3
"""Run existing full HTTP assertions, preserving an early rejection response.
Some servers reject malformed query headers before reading a large body. If a
write hits BrokenPipe, read and assert the actual HTTP response; never infer 400.
"""
import http.client, importlib.util, json, pathlib, sys, urllib.parse
source=pathlib.Path(__file__).resolve().parents[1]/'native-mvp/engine-cpp/tests/native_bridge_http_simulation_test.py'
spec=importlib.util.spec_from_file_location('native_http_suite',source)
suite=importlib.util.module_from_spec(spec);spec.loader.exec_module(suite)
recovered=[]
def request_project_archive(path, method='POST', body=None, content_type=None):
    target=urllib.parse.urlsplit(suite.HOST_URL)
    connection=http.client.HTTPConnection(target.hostname,target.port,timeout=15)
    headers={'Origin':'http://localhost:5173'}
    if content_type is not None:headers['Content-Type']=content_type
    try:
        broken=False
        try:connection.request(method,path,body=body,headers=headers)
        except BrokenPipeError:broken=True # still require the real HTTP response
        response=connection.getresponse()
        payload=response.read()
        if broken:recovered.append({"path":path,"actualStatus":response.status,"bodyBytes":len(payload)})
        return response.status,json.loads(payload.decode('utf-8')) if payload else {}
    finally:connection.close()
suite.request_project_archive=request_project_archive
suite.main()
print(json.dumps({"earlyResponseRecoveries":recovered}))
