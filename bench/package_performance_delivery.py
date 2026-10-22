#!/usr/bin/env python3
"""Create a local recoverable delivery. Never pushes or changes a remote ref."""
import hashlib,json,shutil,subprocess,sys,tarfile
from pathlib import Path
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[1]
D=root/'docs/performance/20261021'
out=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root.parent/'rc505-performance-delivery'
def git(*args):return subprocess.check_output(['git',*args],cwd=root,text=True).strip()
if git('status','--porcelain','--untracked-files=no'):
 raise SystemExit('Refusing to package tracked dirty worktree; commit the tested batch first.')
branch=git('branch','--show-current');head=git('rev-parse','HEAD')
if branch!='perf/rc505-20261021':raise SystemExit('Unexpected branch: '+branch)
out.mkdir(parents=True,exist_ok=True)
bundle=out/'WEBRC505MKII-performance-20261021.bundle'
subprocess.run(['git','bundle','create',str(bundle),branch],cwd=root,check=True)
verification=subprocess.run(['git','bundle','verify',str(bundle)],cwd=root,text=True,capture_output=True,check=True)
(out/'bundle-verification.txt').write_text(verification.stdout+verification.stderr)
report=(D/'用户汇总.md').read_text()
report=report.replace('待最终证据完成后一次提交。',f'`{head}`。')
report=report.replace('本报告所在优化批次提交，准确 hash 见随附交付回执。',f'`{head}`。')
(out/'WEBRC505MKII-性能报告-20261021.md').write_text(report)
with tarfile.open(out/'WEBRC505MKII-performance-evidence-20261021.tar.gz','w:gz') as archive:
 archive.add(D,arcname='performance-evidence')
receipt={'createdUtc':datetime.now(timezone.utc).isoformat(),'branch':branch,'commit':head,'remoteMainPreserved':True,'forcePush':False,'pushStatus':'PUSH_BLOCKED','pushReason':'Execution authorization gate rejected dry-run; no actual push attempted, pending new direct confirmation.','cloudDeployment':'PASS_HTTP_ONLY','userDeviceDeployment':'LOCAL_DEPLOY_BLOCKED','bundleVerify':'PASS'}
receipt['fileSha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.is_file() and p.name not in ['delivery-receipt.json','恢复说明.txt']}
(out/'delivery-receipt.json').write_text(json.dumps(receipt,indent=2,ensure_ascii=False)+'\n')
(out/'恢复说明.txt').write_text(f'''这是本地可恢复 Git bundle，不表示已经推送 GitHub或部署用户设备。\n分支：{branch}\n提交：{head}\n\n在自己选择的新目录可执行：\ngit clone WEBRC505MKII-performance-20261021.bundle -b {branch} rc505-performance-restored\n\n不要覆盖已有 dirty 工作目录，不要 force push。\n完整源码、提交历史及仓库内证据都在 bundle；另附独立证据压缩包与简短中文报告。\n真实浏览器/硬件未验证项目见报告，不能从离线 PASS 推断已通过。\n''')
print(json.dumps({'output':str(out),'branch':branch,'commit':head,'files':[p.name for p in out.iterdir()]},ensure_ascii=False,indent=2))
