"""Exercise released Windows updater helpers against a final candidate archive.

No product model calls. Uses disposable installs and SQLite data. An actual old
EXE owns replacement; a healthy new backend and preserved data are required.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def download_fixture(fixture, directory):
    version = fixture['version']
    archive = directory / (version + '.zip')
    url = f'https://github.com/glanderness/BeefTV/releases/download/{version}/BeefTV-{version}-windows-amd64.zip'
    subprocess.run(['curl.exe', '-fLsS', '--retry', '2', '--max-time', '180', url, '-o', str(archive)], check=True)
    if digest(archive) != fixture['sha256']:
        raise RuntimeError('Published fixture hash mismatch: ' + version)
    unpacked = directory / version
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(unpacked)
    return unpacked


def wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.2)
    raise TimeoutError('Timed out waiting for native updater state')


def stop_installed(executable):
    # Scope process cleanup to this exact disposable install, never by image name.
    path = str(executable).replace("'", "''")
    command = "$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '" + path + "' }; foreach($x in $p){ taskkill /PID $x.ProcessId /T /F | Out-Null; if(Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue){ Wait-Process -Id $x.ProcessId -Timeout 10 -ErrorAction Stop } }; exit 0"
    subprocess.run(['powershell', '-NoProfile', '-Command', command], check=True)


def exercise(source, candidate, version, directory, rollback=False):
    install, staged, data = directory/'install', directory/'payload', directory/'data'
    shutil.copytree(source, install)
    shutil.copytree(candidate, staged)
    if rollback:
        # Structurally valid archive, but CreateProcess must reject its program.
        (staged/'BeefTV.exe').write_bytes(b'not a Windows executable')
    data.mkdir()
    db = data/'open_ai_canvas.db'
    with closing(sqlite3.connect(db)) as connection, connection:
        connection.execute('CREATE TABLE upgrade_audit (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        connection.execute('INSERT INTO upgrade_audit VALUES (1, ?)', ('preserve-existing-data',))
    helper = directory/'BeefTV-update-helper.exe'
    shutil.copy2(install/'BeefTV.exe', helper)
    token = secrets.token_hex(32)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, CANVAS_DESKTOP_DATA_DIR=str(data),
               CANVAS_DESKTOP_BACKEND_ADDR=f'127.0.0.1:{port}',
               CANVAS_DESKTOP_LAUNCH_TOKEN=token)
    parent = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(180)'])
    request = directory/'request.json'
    request.write_text(json.dumps(dict(schema=1, parentPid=parent.pid, platform='windows-amd64',
        targetPath=str(install/'BeefTV.exe'), stagedPath=str(staged), backupPath=str(directory/'backup'),
        preparedPath=str(directory/'prepared'), resultPath=str(directory/'result.json'), waitTimeoutSec=60)), encoding='utf-8')
    process = None
    try:
        process = subprocess.Popen([str(helper), '--beeftv-update-helper', str(request)], env=env)
        wait_until(lambda: (directory/'prepared').exists() or process.poll() is not None, 30)
        if not (directory/'prepared').exists():
            raise RuntimeError((directory/'result.json').read_text(encoding='utf-8'))
        parent.terminate()
        parent.wait(timeout=10)
        process.wait(timeout=90)
        result = json.loads((directory/'result.json').read_text(encoding='utf-8'))
        if rollback:
            if result.get('status') != 'rolled_back' or not result.get('restored'):
                raise RuntimeError('Failed update did not restore the old install: ' + json.dumps(result))
            for relative in ['BeefTV.exe', 'agent-host/server.mjs', 'agent-host/runtime/node.exe']:
                if digest(install/relative) != digest(source/relative):
                    raise RuntimeError('Rollback changed original file: ' + relative)
            if (install/'cli').exists() != (source/'cli').exists():
                raise RuntimeError('Rollback did not preserve the original CLI presence')
            with closing(sqlite3.connect(db)) as connection:
                if connection.execute('SELECT value FROM upgrade_audit WHERE id=1').fetchone() != ('preserve-existing-data',):
                    raise RuntimeError('Rollback changed existing data')
            return dict(rollback=True, oldInstallRestored=True, sqlitePreserved=True)
        if process.returncode or result.get('status') != 'launched' or not result.get('parentExited'):
            raise RuntimeError(json.dumps(result))
        for relative in ['BeefTV.exe', 'cli/beeftv.exe', 'agent-host/server.mjs', 'agent-host/runtime/node.exe']:
            if digest(install/relative) != digest(candidate/relative):
                raise RuntimeError('Installed payload differs: ' + relative)
        health = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def ready():
            nonlocal health
            request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health/ready', headers={'X-Desktop-Token':token})
            try:
                with opener.open(request, timeout=2) as response:
                    health = json.loads(response.read())
                    return response.status == 200 and health.get('code') == 0
            except (OSError, ValueError):
                return False
        wait_until(ready, 45)
        with closing(sqlite3.connect(db)) as connection:
            if connection.execute('SELECT value FROM upgrade_audit WHERE id=1').fetchone() != ('preserve-existing-data',):
                raise RuntimeError('Existing SQLite data changed')
        identity = hashlib.sha256(os.path.normpath(str(data)).lower().encode()).hexdigest()
        runtime_path = Path(os.environ['USERPROFILE'])/'.beeftv'/'runtime'/(identity+'.json')
        runtime = json.loads(runtime_path.read_text(encoding='utf-8'))
        if runtime['version'] != version:
            raise RuntimeError('Wrong application version started')
        return dict(replaced=True, backendReady=True, sqlitePreserved=True, version=version,
                    boundary='released helper replacement and backend; no GUI or paid-generation acceptance')
    finally:
        if parent.poll() is None:
            parent.terminate()
            parent.wait(timeout=10)
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        stop_installed(install/'BeefTV.exe')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('This gate requires native Windows')
    fixtures = json.loads(Path(__file__).with_name('windows-upgrade-fixtures.json').read_text())
    receipts = []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='BeefTV-upgrade-') as temporary:
        # Windows TEMP can contain an 8.3 alias; CIM reports full executable paths.
        root = Path(temporary).resolve()
        candidate = root/'candidate'
        with zipfile.ZipFile(args.archive) as bundle:
            bundle.extractall(candidate)
        for fixture in fixtures['currentLayout']:
            source = download_fixture(fixture, root)
            case = root/('case-'+fixture['version'])
            case.mkdir()
            try:
                result = exercise(source, candidate, args.version, case)
                receipts.append(dict(source=fixture['version'], **result))
                rollback_case = root/('rollback-'+fixture['version'])
                rollback_case.mkdir()
                result = exercise(source, candidate, args.version, rollback_case, rollback=True)
                receipts.append(dict(source=fixture['version'], **result))
            except Exception as error:
                receipts.append(dict(source=fixture['version'], passed=False, error=str(error)))
                raise
            finally:
                args.output.write_text(json.dumps(receipts, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f"PASS {fixture['version']} -> {args.version}: replacement, backend, SQLite", flush=True)


if __name__ == '__main__':
    main()
