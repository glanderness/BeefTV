"""Actual published EXE helper probes on a disposable Windows runner.
The Python parent stays alive so every helper stops before replacing files.
"""
import base64, hashlib, json, os, subprocess, time, zipfile, shutil, sys, urllib.request
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

# Exercise replacement using unmodified released helpers and complete real payloads.
# Data is isolated; this is process/runtime evidence, not a human GUI acceptance.
for source,target in [('v1.6.20','v1.6.21'),('v1.6.21','v1.6.22'),('v1.6.23','v1.7.2'),('v1.7.1','v1.7.2')]:
    case=root/('swap-'+source+'-to-'+target)
    case.mkdir()
    install=case/'install'
    staged=case/'payload'
    data=case/'isolated-data'
    data.mkdir()
    (data/'preservation-sentinel.txt').write_text('keep-existing-data')
    shutil.copytree(root/source/'unpacked',install)
    shutil.copytree(root/target/'unpacked',staged)
    helper=case/'BeefTV-update-helper.exe'
    shutil.copy2(install/'BeefTV.exe',helper)
    parent=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
    req=case/'request.json'
    req.write_text(json.dumps(dict(schema=1,parentPid=parent.pid,platform='windows-amd64',targetPath=str(install/'BeefTV.exe'),stagedPath=str(staged),backupPath=str(case/'backup'),preparedPath=str(case/'prepared'),resultPath=str(case/'result.json'),waitTimeoutSec=60)),encoding='utf-8')
    env=dict(os.environ,CANVAS_DESKTOP_DATA_DIR=str(data))
    process=subprocess.Popen([str(helper),'--beeftv-update-helper',str(req)],env=env)
    deadline=time.monotonic()+30
    while time.monotonic()<deadline and process.poll() is None and not (case/'prepared').exists(): time.sleep(.2)
    parent.terminate()
    parent.wait(timeout=10)
    process.wait(timeout=60)
    recovery=json.loads((case/'result.json').read_text(encoding='utf-8'))
    same=hashlib.sha256((install/'BeefTV.exe').read_bytes()).digest()==hashlib.sha256((root/target/'unpacked'/'BeefTV.exe').read_bytes()).digest()
    descriptor=data/'runtime.json'
    if target=='v1.7.2':
        identity=hashlib.sha256(os.path.normpath(str(data)).lower().encode()).hexdigest()
        descriptor=Path(os.environ['USERPROFILE'])/'.beeftv'/'runtime'/(identity+'.json')
    deadline=time.monotonic()+25
    while time.monotonic()<deadline and not descriptor.exists(): time.sleep(.25)
    runtime_info=json.loads(descriptor.read_text(encoding='utf-8')) if descriptor.exists() else None
    health=None
    if runtime_info:
        for suffix in ['/health/ready','/api/health/ready']:
            try:
                with urllib.request.urlopen(runtime_info['baseUrl']+suffix,timeout=5) as response:
                    health={'status':response.status,'body':response.read().decode()}
                break
            except Exception as error: health={'error':str(error)}
    result=dict(source=source,target=target,replacement=recovery,installedExeHashMatches=same,dataSentinelPreserved=(data/'preservation-sentinel.txt').read_text()=='keep-existing-data',runtime=runtime_info,health=health,boundary='actual released helper swap, process launch and isolated backend; no GUI interaction')
    results.append(result)
    save()
    print(json.dumps(result,ensure_ascii=True),flush=True)
    # Kill only the application from this disposable case, including its children.
    script="$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '"+str(install/'BeefTV.exe').replace("'","''")+"' }; foreach($x in $p){ taskkill /PID $x.ProcessId /T /F }"
    subprocess.run(['powershell','-NoProfile','-Command',script],check=False)
    assert same and recovery.get('launched'),result
