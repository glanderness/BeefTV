"""Actual published EXE helper probes on a disposable Windows runner.
The Python parent stays alive so every helper stops before replacing files.
"""
import base64, hashlib, json, os, subprocess, time, zipfile
from pathlib import Path

versions = ['v1.6.20','v1.6.21','v1.6.22','v1.6.23','v1.7.1','v1.7.2']
root = Path(os.environ['RUNNER_TEMP']) / 'beeftv-update-audit'
root.mkdir(exist_ok=True)
out = Path('audit-evidence')
out.mkdir(exist_ok=True)
results = []
def save():
    (out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
for version in versions:
    package = root/version
    package.mkdir(exist_ok=True)
    for name in ['desktop-update.json',f'BeefTV-{version}-windows-amd64.zip']:
        subprocess.run(['curl.exe','-fLsS','--retry','2','--max-time','180',f'https://github.com/glanderness/BeefTV/releases/download/{version}/{name}','-o',str(package/name)],check=True)
    manifest = json.loads(base64.b64decode(json.loads((package/'desktop-update.json').read_text())['payload']))
    asset = manifest['platforms']['windows-amd64']
    archive = package/f'BeefTV-{version}-windows-amd64.zip'
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==asset['sha256']
    assert archive.stat().st_size==asset['size']
    with zipfile.ZipFile(archive) as z: z.extractall(package/'unpacked')
    results.append({'version':version,'downloadHash':'passed','sha256':asset['sha256']})
    save()
edges = [(v,'v1.7.2') for v in versions[:-1]] + list(zip(versions[:4],versions[1:5]))
for source,target in edges:
    case = root/(source+'-to-'+target)
    case.mkdir(exist_ok=True)
    request = dict(schema=1,parentPid=os.getpid(),platform='windows-amd64',targetPath=str(case/'BeefTV.exe'),stagedPath=str(root/target/'unpacked'),backupPath=str(case/'backup'),preparedPath=str(case/'prepared'),resultPath=str(case/'result.json'),waitTimeoutSec=60)
    req=case/'request.json'
    req.write_text(json.dumps(request),encoding='utf-8')
    env=dict(os.environ,CANVAS_BACKEND_DATA_DIR=str(case/'isolated-data'))
    with (case/'helper.log').open('wb') as log:
        p=subprocess.Popen([str(root/source/'unpacked'/'BeefTV.exe'),'--beeftv-update-helper',str(req)],stdout=log,stderr=log,env=env)
        deadline=time.monotonic()+25
        while time.monotonic()<deadline and p.poll() is None and not (case/'prepared').exists(): time.sleep(.2)
        prepared=(case/'prepared').exists()
        if p.poll() is None: p.terminate()
        p.wait(timeout=10)
    recovery=json.loads((case/'result.json').read_text(encoding='utf-8')) if (case/'result.json').exists() else None
    result=dict(source=source,target=target,acceptedLayout=prepared,recovery=recovery,exitCode=p.returncode,boundary='actual released EXE helper validation; stopped before replacement')
    results.append(result)
    save()
    print(json.dumps(result,ensure_ascii=True),flush=True)
    if not prepared and recovery is None: raise RuntimeError((case/'helper.log').read_text(errors='replace'))
