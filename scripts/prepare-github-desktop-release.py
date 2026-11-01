#!/usr/bin/env python3
"""Validate a tag release and its complete desktop download inventory."""
import argparse
import hashlib
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    'windows-amd64': '-setup.exe',
    'linux-amd64': '.deb',
    'darwin-arm64': '.dmg',
    'darwin-amd64': '.dmg',
}


def release_notes(tag, version, changelog):
    if not re.fullmatch(r'aihubkit-v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('Desktop installers require an independent tag: aihubkit-vMAJOR.MINOR.PATCH')
    app_version = tag.removeprefix('aihubkit-')
    if app_version != version.strip():
        raise ValueError(f'Tag {tag} does not match VERSION={version.strip()}')
    lines = changelog.splitlines()
    heading = f'## {app_version}'
    if heading not in lines:
        raise ValueError(f'CHANGELOG.md is missing {heading}')
    body = []
    for line in lines[lines.index(heading) + 1:]:
        if line.startswith('## '):
            break
        body.append(line)
    changes = '\n'.join(body).strip()
    if not changes:
        raise ValueError(f'CHANGELOG.md has no release notes for {tag}')
    return f'''{changes}

## 下载与安装

| 系统 | 安装包 |
| --- | --- |
| Windows x64 | `BeefTV-{app_version}-windows-amd64-setup.exe` |
| Ubuntu 24.04 x64 | `BeefTV-{app_version}-linux-amd64.deb` |
| macOS Apple Silicon | `BeefTV-{app_version}-darwin-arm64.dmg` |
| macOS Intel | `BeefTV-{app_version}-darwin-amd64.dmg` |

Windows 运行 Setup；macOS 打开 DMG 并拖入 Applications；Ubuntu 运行
`sudo apt install ./BeefTV-{app_version}-linux-amd64.deb`。
ZIP 用于便携运行，解压时保留全部文件。安装包包含前端、后端、CLI、助手运行时和官方插件，用户无需安装 Go、Bun 或 Node.js。

Windows 缺少 WebView2 时需按提示安装。Linux DEB 会通过 apt 安装系统依赖。
Windows 未做 Authenticode 签名；macOS 使用 ad hoc 签名，未做 Apple 公证，首次运行可能需要系统放行。
本次 tag 构建不启用官方应用内自动更新，升级时请下载并安装新版。

`SHA256SUMS.txt` 包含所有下载文件的 SHA-256。媒体组件的对应源码包一并提供。
'''


def prepare_assets(directory, tag):
    app_version = tag.removeprefix('aihubkit-')
    expected = {f'BeefTV-{app_version}-{target}{suffix}' for target, suffix in TARGETS.items()}
    expected |= {f'BeefTV-{app_version}-{target}.zip' for target in TARGETS}
    expected |= {f'BeefTV-{app_version}-ffprobe-{target}-sources.tar.gz'
                 for target in TARGETS if target.startswith('darwin-')}
    expected.add(f'BeefTV-{app_version}-ffmpeg-wasm-sources.tar.gz')
    for name in sorted(expected):
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Missing or empty release asset: {name}')
    unexpected = {path.name for path in directory.iterdir()} - expected - {'SHA256SUMS.txt'}
    if unexpected:
        raise ValueError(f'Unexpected release assets: {", ".join(sorted(unexpected))}')
    checksums = []
    for name in sorted(expected):
        with (directory / name).open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        checksums.append(f'{digest}  {name}\n')
    (directory / 'SHA256SUMS.txt').write_text(''.join(checksums), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--notes', required=True, type=Path)
    parser.add_argument('--assets-dir', type=Path)
    args = parser.parse_args()
    notes = release_notes(args.tag, (ROOT / 'VERSION').read_text(),
                          (ROOT / 'CHANGELOG.md').read_text(encoding='utf-8'))
    if args.assets_dir:
        prepare_assets(args.assets_dir, args.tag)
    args.notes.write_text(notes, encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from error
