"""Remove externally supplied PyTorch distributions from a verified full runtime.

The builder still self-tests the complete runtime before this packaging step.
This step only creates a separate base artifact; it never edits the old archive.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import zipfile

SITE = '.python/Lib/site-packages/'
PACKAGES = ('torch', 'torchvision')
NAME = re.compile(r'^(torch|torchvision)-[0-9]+\.[0-9]+\.[0-9]+\+cu128-cp311-cp311-win_amd64\.whl$')


def normalized(name):
    name = name.replace('\\', '/')
    if name.startswith('/') or ':' in name or '..' in name.split('/'):
        raise ValueError('unsafe runtime path')
    return name


def split_archive(source, target):
    if target.exists():
        raise ValueError('refusing to overwrite an existing base artifact')
    with zipfile.ZipFile(source) as original:
        entries = {normalized(entry.filename): entry for entry in original.infolist()}
        if len(entries) != len(original.infolist()):
            raise ValueError('duplicate normalized runtime path')
        if SITE + 'pip/__main__.py' not in entries:
            raise ValueError('base runtime must already include its offline pip')
        removed = set()
        roots = set()
        versions = {}
        for package in PACKAGES:
            records = [n for n in entries if n.startswith(SITE + package + '-') and n.endswith('.dist-info/RECORD')]
            if len(records) != 1:
                raise ValueError('expected exactly one installed ' + package + ' distribution')
            record = records[0]
            info_root = record.rsplit('/', 1)[0]
            version = info_root[len(SITE + package + '-'):-len('.dist-info')]
            if not NAME.fullmatch(f'{package}-{version}-cp311-cp311-win_amd64.whl'):
                raise ValueError('unsupported CUDA wheel version')
            versions[package] = version
            roots.add(info_root + '/')
            owned_roots = [SITE + package + '/', info_root + '/', SITE + package + '.libs/']
            if package == 'torch':
                owned_roots.extend(SITE + extra + '/' for extra in ('functorch', 'torchgen'))
            scripts = {SITE + 'bin/' + name for name in ('torchrun.exe', 'torchfrtrace.exe')} if package == 'torch' else set()
            for path, *_ in csv.reader(io.StringIO(original.read(entries[record]).decode('utf-8'))):
                owned = posixpath.normpath(SITE + path.replace('\\', '/'))
                if owned not in scripts and not any(owned.startswith(prefix) for prefix in owned_roots):
                    raise ValueError('distribution record is not owned by ' + package)
                removed.add(owned)
        # Generated pyc files are not always in RECORD. These are all Python
        # import roots shipped by torch/torchvision, including functorch/torchgen.
        roots.update(SITE + p + '/' for p in ('torch', 'torchvision', 'torchgen', 'functorch'))
        kept = [n for n in entries if n not in removed and not any(n.startswith(p) for p in roots)]
        if not any(n.startswith(SITE + 'numpy/') for n in kept):
            raise ValueError('split lost a required non-Torch dependency')
        for critical in ('.python/python.exe', SITE + 'pip/__main__.py'):
            if critical not in kept:
                raise ValueError('split lost the interpreter or offline pip')
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as result:
                for name in kept:
                    entry = entries[name]
                    header = zipfile.ZipInfo(name, entry.date_time)
                    header.compress_type = zipfile.ZIP_DEFLATED
                    header.external_attr = entry.external_attr
                    with original.open(entry) as reader, result.open(header, 'w', force_zip64=True) as writer:
                        while chunk := reader.read(1024 * 1024):
                            writer.write(chunk)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    with zipfile.ZipFile(target) as result:
        files = len(result.infolist())
        expanded = sum(entry.file_size for entry in result.infolist())
    with target.open('rb') as reader:
        digest = hashlib.file_digest(reader, 'sha256').hexdigest()
    return {'name': target.name, 'size': target.stat().st_size, 'sha256': digest,
            'files': files, 'expandedSize': expanded, 'externalVersions': versions,
            'removedFiles': len(entries) - len(kept)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--input-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with args.input.open('rb') as reader:
        digest = hashlib.file_digest(reader, 'sha256').hexdigest()
    if digest != args.input_sha256:
        raise ValueError('complete source archive SHA256 mismatch')
    metadata = split_archive(args.input, args.output)
    metadata['sourceSHA256'] = digest
    args.output.with_suffix(args.output.suffix + '.json').write_text(json.dumps(metadata, indent=2)+'\n')
    print(json.dumps(metadata, indent=2))
