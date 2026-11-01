import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'github_release', Path(__file__).with_name('prepare-github-desktop-release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

TAG = 'aihubkit-v2.3.4'
APP_VERSION = 'v2.3.4'
ASSETS = [
    'windows-amd64-setup.exe', 'linux-amd64.deb',
    'darwin-arm64.dmg', 'darwin-amd64.dmg',
    'windows-amd64.zip', 'linux-amd64.zip', 'darwin-arm64.zip', 'darwin-amd64.zip',
    'ffprobe-darwin-arm64-sources.tar.gz', 'ffprobe-darwin-amd64-sources.tar.gz',
    'ffmpeg-wasm-sources.tar.gz',
]


class ReleaseMetadataTests(unittest.TestCase):
    def test_extracts_only_selected_version_and_explains_installation(self):
        notes = release.release_notes(TAG, APP_VERSION + '\n',
                                      f'## Unreleased\nfuture\n## {APP_VERSION}\nselected\n## v2.3.3\nold\n')
        self.assertTrue(notes.startswith('selected\n'))
        self.assertNotIn('future', notes)
        self.assertNotIn('\nold\n', notes)
        for installer in ASSETS[:4]:
            self.assertIn(f'BeefTV-{APP_VERSION}-{installer}', notes)
        self.assertIn('WebView2', notes)
        self.assertIn('不启用官方应用内自动更新', notes)

    def test_rejects_mismatch_and_unsupported_versions(self):
        for tag, version in [(TAG, 'v2.3.3'), ('aihubkit-v2.3.4-rc.1', 'v2.3.4-rc.1'),
                             ('aihubkit-v2.3', 'v2.3'), ('v2.3.4', 'v2.3.4')]:
            with self.subTest(tag=tag, version=version), self.assertRaises(ValueError):
                release.release_notes(tag, version, f'## {version}\nchanges')

    def test_requires_nonempty_changelog_entry(self):
        for changelog in ['## v2.3.3\nold', f'## {APP_VERSION}\n\n## v2.3.3\nold']:
            with self.subTest(changelog=changelog), self.assertRaises(ValueError):
                release.release_notes(TAG, APP_VERSION, changelog)


class ReleaseAssetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        for suffix in ASSETS:
            (self.directory / f'BeefTV-{APP_VERSION}-{suffix}').write_bytes(suffix.encode())

    def test_checksums_cover_every_installer_archive_and_source_bundle(self):
        release.prepare_assets(self.directory, TAG)
        checksums = (self.directory / 'SHA256SUMS.txt').read_text().splitlines()
        self.assertEqual(len(checksums), 11)
        for line in checksums:
            digest, name = line.split('  ')
            self.assertEqual(digest, hashlib.sha256((self.directory / name).read_bytes()).hexdigest())
        release.prepare_assets(self.directory, TAG)
        self.assertEqual(checksums, (self.directory / 'SHA256SUMS.txt').read_text().splitlines())

    def test_any_missing_download_blocks_publication(self):
        for suffix in ASSETS:
            path = self.directory / f'BeefTV-{APP_VERSION}-{suffix}'
            content = path.read_bytes()
            path.unlink()
            with self.subTest(missing=suffix), self.assertRaises(ValueError):
                release.prepare_assets(self.directory, TAG)
            self.assertFalse((self.directory / 'SHA256SUMS.txt').exists())
            path.write_bytes(content)

    def test_rejects_empty_files_and_symlinks(self):
        path = self.directory / f'BeefTV-{APP_VERSION}-windows-amd64.zip'
        path.write_bytes(b'')
        with self.assertRaises(ValueError):
            release.prepare_assets(self.directory, TAG)
        path.unlink()
        path.symlink_to(self.directory / f'BeefTV-{APP_VERSION}-linux-amd64.zip')
        with self.assertRaises(ValueError):
            release.prepare_assets(self.directory, TAG)

    def test_rejects_accidental_extra_files(self):
        (self.directory / '.env').write_text('private configuration')
        with self.assertRaisesRegex(ValueError, 'Unexpected release assets'):
            release.prepare_assets(self.directory, TAG)


if __name__ == '__main__':
    unittest.main()
