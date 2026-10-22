#!/usr/bin/env node
// Bounded production cloud startup/HTTP smoke. No UI or user-device claim.
import { preview } from 'vite';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
const destination=resolve(process.argv[2]??'docs/performance/20261021/cloud-preview.json');
const report={startedAt:new Date().toISOString(),command:'node bench/verify_cloud_preview.mjs',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'cloud executor production Vite preview; not user Windows deployment or browser UI validation',localDeploymentStatus:'LOCAL_DEPLOY_BLOCKED',localDeploymentReason:'No user device is used under the approved cloud-only scope.',browserUiVerified:false,requests:[],errors:[]};
report.worktreeDirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
report.candidateWorkletSourceSha256=createHash('sha256').update(await readFile('public/worklets/fx-processor.js')).digest('hex');
let server;
const startupStarted=performance.now();
try {
 server=await preview({preview:{host:'127.0.0.1',port:4177,strictPort:true}});
 const base='http://127.0.0.1:4177';report.url=base;
 const response=await fetch(base+'/');const html=await response.text();
 report.requests.push({path:'/',status:response.status,bytes:Buffer.byteLength(html)});
 if(!response.ok||!html.includes('<div id="app">'))throw Error('Production app entry missing');
 const paths=new Set([...html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map(m=>m[1]));
 for(const path of paths){const r=await fetch(base+path);const bytes=Buffer.from(await r.arrayBuffer());report.requests.push({path,status:r.status,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});if(!r.ok)throw Error(`Asset failed: ${path} ${r.status}`);}
 report.distIndexSha256=createHash('sha256').update(await readFile('dist/index.html')).digest('hex');
 report.httpSmokeStatus='PASS';
 report.cloudStartupAndAssetFetchMs=performance.now()-startupStarted;
 report.startupMetricScope='Vite preview listen through entry and asset HTTP retrieval, not browser UI/audio startup';
} catch(error){report.httpSmokeStatus='FAIL';report.errors.push(String(error));process.exitCode=1;}
finally {if(server)await new Promise(resolve=>server.httpServer.close(resolve));report.serverClosed=true;report.finishedAt=new Date().toISOString();await mkdir(dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
