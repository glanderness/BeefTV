"""No cloud writes: fake S3, actual local HTTP readback, existing verifier boundary."""

import base64
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import tempfile
import threading
import unittest
import io
from contextlib import redirect_stderr
from unittest.mock import Mock, patch
import urllib.request
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("publish_desktop_r2", Path(__file__).with_name("publish-desktop-r2.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.reads = []
        self.before_put = None

    def get(self, key, destination):
        if key not in self.objects:
            return None
        content = self.objects[key]
        self.reads.append((key, len(content)))
        Path(destination).write_bytes(content)
        return hashlib.sha256(content).hexdigest()

    def put(self, key, source, cache_control, etag=None):
        if self.before_put:
            self.before_put(key)
        current = self.objects.get(key)
        if etag is None and current is not None:
            return False
        if etag is not None and (current is None or hashlib.sha256(current).hexdigest() != etag):
            return False
        self.objects[key] = Path(source).read_bytes()
        self.writes.append((key, cache_control))
        return True


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.store = FakeS3()
        self.cnb_store = FakeS3()
        store = self.store
        self.public_requests = []
        requests = self.public_requests
        self.transfers = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                agent = self.headers.get("User-Agent", "")
                requests.append((self.path, agent))
                if not re.fullmatch(r"BeefTV-Desktop-Updater/v\d+\.\d+\.\d+", agent):
                    self.send_error(403)
                    return
                origin_header = self.headers.get("X-Test-Origin")
                origin = fixture.cnb_store if origin_header == "cnb" else store
                content = origin.objects.get(self.path.lstrip("/"))
                if content is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(content)))
                self.send_header("ETag", '"' + hashlib.sha256(content).hexdigest() + '"')
                self.end_headers()
                fixture.transfers.append((self.path, 200, len(content)))
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

        def opener(request, timeout):
            url = f"http://127.0.0.1:{self.server.server_port}{urlsplit(request.full_url).path}"
            headers = dict(request.header_items())
            host = urlsplit(request.full_url).hostname
            if host == "cnb.cool":
                headers["X-Test-Origin"] = "cnb"
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)

        # Cryptography belongs to the existing Go verifier. Exercise invocation
        # and its failure result here, without replacing production verification.
        self.verifier = patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.verify_command = self.verifier.start()
        self.addCleanup(self.verifier.stop)
        self.publisher = release.Publisher(self.store, release.PublicHTTP(opener), "/tmp/update-release",
                                           "https://updates.beefapi.com/beeftv", lambda *args: None)

    def manifest(self, version="v1.5.7", omit=None, copies=32):
        platforms = {}
        for platform in sorted(release.PLATFORMS):
            if platform == omit:
                continue
            name = f"BeefTV-{version}-{platform}.zip"
            data = (version + platform).encode() * copies
            (self.root / name).write_bytes(data)
            platforms[platform] = {"url": f"https://updates.beefapi.com/beeftv/{version}/{name}",
                                   "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        payload = {"schema": 1, "version": version, "commit": "a" * 40, "notes": "test release", "platforms": platforms}
        path = self.root / f"{version}.json"
        path.write_text(json.dumps({"payload": base64.b64encode(json.dumps(payload).encode()).decode(), "signature": "fixture"}))
        return path

    def manifest_v2(self, version="v1.5.7", with_domestic=False, from_version=None, copies=32):
        platforms = {}
        for platform in sorted(release.PLATFORMS):
            name = f"BeefTV-{version}-{platform}.zip"
            data = (version + platform).encode() * copies
            (self.root / name).write_bytes(data)
            r2_url = f"https://updates.beefapi.com/beeftv/{version}/{name}"
            cnb_url = f"{release.CNB_PUBLIC_BASE}/{version}/{name}"
            urls = [cnb_url, r2_url] if with_domestic else [r2_url]
            entry = {"urls": urls, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            if from_version:
                d_name = f"BeefTV-{version}-{platform}-from-{from_version}.delta.zip"
                d_data = (f"delta-{from_version}-{version}-{platform}").encode() * 8
                (self.root / d_name).write_bytes(d_data)
                d_r2_url = f"https://updates.beefapi.com/beeftv/{version}/{d_name}"
                d_cnb_url = f"{release.CNB_PUBLIC_BASE}/{version}/{d_name}"
                d_urls = [d_cnb_url, d_r2_url] if with_domestic else [d_r2_url]
                entry["deltas"] = {from_version: {"urls": d_urls, "size": len(d_data), "sha256": hashlib.sha256(d_data).hexdigest()}}
            platforms[platform] = entry
        payload = {"schema": 2, "version": version, "commit": "a" * 40, "notes": "test release", "platforms": platforms}
        suffix = "v2-domestic" if with_domestic else "v2-r2"
        path = self.root / f"{version}-{suffix}.json"
        path.write_text(json.dumps({"payload": base64.b64encode(json.dumps(payload).encode()).decode(), "signature": "fixture"}))
        return path

    def test_activate_v2_requires_active_r2_v1_feed_and_upgrades_r2_only_to_domestic_after_verification(self):
        v1 = self.manifest("v2.1.0")
        v2_r2 = self.manifest_v2("v2.1.0", with_domestic=False, from_version="v2.0.6")
        v2_domestic = self.manifest_v2("v2.1.0", with_domestic=True, from_version="v2.0.6")
        self.publisher.stage(v1, self.root, manifest_v2=v2_r2)
        # Before R2 v1 feed is activated, v2 cannot be activated
        with self.assertRaisesRegex(release.PublishError, "v1 feed must be active"):
            self.publisher.activate_v2(v2_r2)
        self.assertNotIn(release.LATEST_V2, self.store.objects)
        # Activate R2 v1 feed, then activate R2-only v2 feed (including staged R2 delta zips)
        self.publisher.activate(v1)
        self.assertEqual(self.publisher.activate_v2(v2_r2), "v2.1.0")
        self.assertEqual(self.store.objects[release.LATEST_V2], v2_r2.read_bytes())
        # Domestic v2 manifest must fail when CNB assets (or CNB deltas) are missing, keeping R2-only v2 feed intact
        with self.assertRaises(release.PublishError):
            self.publisher.activate_v2(v2_domestic)
        self.assertEqual(self.store.objects[release.LATEST_V2], v2_r2.read_bytes())
        # Populate verified CNB full ZIPs and delta ZIPs, then upgrade v2 feed to domestic+R2
        for platform in release.PLATFORMS:
            for name in (f"BeefTV-v2.1.0-{platform}.zip", f"BeefTV-v2.1.0-{platform}-from-v2.0.6.delta.zip"):
                self.cnb_store.objects[f"beeftv-downloads/desktop/-/releases/download/v2.1.0/{name}"] = (self.root / name).read_bytes()
        self.assertEqual(self.publisher.activate_v2(v2_domestic), "v2.1.0")
        self.assertEqual(self.store.objects[release.LATEST_V2], v2_domestic.read_bytes())
        v2_backups = [val for key, val in self.store.objects.items() if key.startswith("beeftv/latest-v2-backups/")]
        self.assertEqual(v2_backups, [v2_r2.read_bytes()])
        # Idempotent re-run succeeds, but downgrading back to R2-only for the same version is rejected
        self.assertEqual(self.publisher.activate_v2(v2_domestic), "v2.1.0")
        with self.assertRaisesRegex(release.PublishError, "conflicting"):
            self.publisher.activate_v2(v2_r2)
        self.assertEqual(self.store.objects[release.LATEST_V2], v2_domestic.read_bytes())

    def test_installers_are_required_before_any_write_and_read_back_before_activation(self):
        manifest = self.manifest()
        with self.assertRaisesRegex(release.PublishError, 'Installer missing'):
            self.publisher.stage(manifest, self.root, with_installers=True)
        self.assertEqual(self.store.writes, [])
        names = ['darwin-arm64.dmg', 'darwin-amd64.dmg', 'windows-amd64-setup.exe', 'linux-amd64.deb']
        for name in names:
            (self.root / ('BeefTV-v1.5.7-' + name)).write_bytes(name.encode())
        self.publisher.stage(manifest, self.root, with_installers=True)
        self.assertNotIn(release.LATEST, self.store.objects)
        key = release.PREFIX + '/v1.5.7/BeefTV-v1.5.7-linux-amd64.deb'
        self.assertEqual(self.store.objects[key], b'linux-amd64.deb')
        self.store.objects[key] = b'corrupt'
        with self.assertRaises(release.PublishError):
            self.publisher.activate(manifest, self.root)
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_complete_stage_does_not_activate_and_retries_are_idempotent(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.assertEqual(len(self.store.writes), len(release.PLATFORMS) + 1)
        self.assertTrue(all(agent == "BeefTV-Desktop-Updater/v1.5.7" for _, agent in self.public_requests))
        self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), len(release.PLATFORMS) + 1)
        self.assertEqual(self.verify_command.call_args.args[0], ["/tmp/update-release", "verify", "--envelope", str(manifest)])

    def test_public_readback_uses_updater_user_agent_instead_of_urllib_default(self):
        data = b"public release asset"
        self.store.objects["beeftv/probe"] = data
        url = f"http://127.0.0.1:{self.server.server_port}/beeftv/probe"
        with self.assertRaises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(url)
        self.assertEqual(failure.exception.code, 403)
        release.PublicHTTP().check(url, len(data), hashlib.sha256(data).hexdigest(), version="v1.5.8")
        self.assertEqual(self.public_requests[-1][1], "BeefTV-Desktop-Updater/v1.5.8")

    def test_cli_stage_and_activate_rehash_full_objects_and_detect_tail_corruption(self):
        manifest = self.manifest(copies=512)
        argv = ['publish', 'stage', '--manifest', str(manifest), '--verifier', '/tmp/update-release',
                '--endpoint-url', 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com']
        http, publisher = release.PublicHTTP, release.Publisher
        self.store.check_conditions = Mock()
        def make_publisher(*args, **kwargs):
            return publisher(*args, **kwargs, release_check=lambda *a: None)
        with patch.object(release, 'storage_config', return_value=self.store), \
                patch.object(release, 'PublicHTTP', side_effect=lambda: http(self.publisher.public.opener)), \
                patch.object(release, 'Publisher', side_effect=make_publisher), patch('builtins.print'):
            with patch('sys.argv', argv):
                self.assertEqual(release.main(), 0)
            self.transfers.clear()
            argv[1] = 'activate'
            with patch('sys.argv', argv):
                self.assertEqual(release.main(), 0)
            packages = [x for x in self.transfers if not x[0].endswith('.json')]
            self.assertEqual(len(packages), 4)
            self.assertTrue(all(status == 200 and size > 1024 for _, status, size in packages))
            key = next(k for k in self.store.objects if k.endswith('.zip'))
            original = self.store.objects[key]
            self.store.objects[key] = original[:1024] + b'!' * (len(original) - 1024)
            with patch('sys.argv', argv), redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
            self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())

    def test_incomplete_platform_set_cannot_activate(self):
        manifest = self.manifest(omit="windows-amd64")
        with self.assertRaisesRegex(release.PublishError, "four"):
            self.publisher.activate(manifest)
        self.assertFalse(self.store.writes)

    def test_missing_local_archive_and_bad_hash_write_nothing(self):
        manifest = self.manifest()
        source = self.root / "BeefTV-v1.5.7-windows-amd64.zip"
        source.unlink()
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        source.write_bytes(b"wrong archive")
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_invalid_signature_cannot_upload(self):
        manifest = self.manifest()
        self.verify_command.return_value = subprocess.CompletedProcess([], 1, "", "private diagnostic")
        with self.assertRaisesRegex(release.PublishError, "signature"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_existing_immutable_version_cannot_be_overwritten(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "beeftv/v1.5.7/BeefTV-v1.5.7-darwin-amd64.zip"
        self.store.objects[key] = b"existing different version content"
        writes = len(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "Immutable"):
            self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), writes)
        self.assertEqual(self.store.objects[key], b"existing different version content")

    def test_missing_or_corrupt_public_asset_blocks_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "beeftv/v1.5.7/BeefTV-v1.5.7-windows-amd64.zip"
        original = self.store.objects.pop(key)
        with self.assertRaises(release.PublishError):
            self.publisher.activate(manifest)
        self.store.objects[key] = b"x" * len(original)
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_activation_backs_up_latest_and_rejects_downgrade(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        self.publisher.activate(new)
        backups = [value for key, value in self.store.objects.items() if key.startswith("beeftv/latest-backups/")]
        self.assertEqual(backups, [old.read_bytes()])
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())
        self.assertIn((release.LATEST, release.REVALIDATE), self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "downgrade"):
            self.publisher.activate(old)
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())

    def test_concurrent_latest_change_is_not_overwritten(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        future = self.manifest("v1.5.8").read_bytes()

        def race(key):
            if key == release.LATEST:
                self.store.objects[key] = future

        self.store.before_put = race
        with self.assertRaisesRegex(release.PublishError, "concurrently"):
            self.publisher.activate(new)
        self.assertEqual(self.store.objects[release.LATEST], future)

    def test_official_release_gate_precedes_latest_write(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        for metadata in [
            {"draft": True},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": "wrong"},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": payload["commit"], "assets": []},
        ]:
            def response(command):
                return subprocess.CompletedProcess(command, 0, json.dumps(metadata) if command[0] == "gh" else "", "")
            self.verify_command.side_effect = response
            with self.assertRaises(release.PublishError):
                self.publisher.activate(manifest)
            self.assertNotIn(release.LATEST, self.store.objects)

    def test_github_latest_version_and_public_bytes_gate_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        metadata = {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"],
                    "target_commitish": payload["commit"], "assets": [{"name": name, "state": "uploaded"} for name in
                    ["desktop-update.json"] + [f"BeefTV-{payload['version']}-{platform}.zip" for platform in release.PLATFORMS]]}
        latest_tag = "v1.5.6"

        def response(command):
            if command[0] != "gh":
                return subprocess.CompletedProcess(command, 0, "", "")
            value = {"tag_name": latest_tag} if command[-1].endswith("/latest") else metadata
            return subprocess.CompletedProcess(command, 0, json.dumps(value), "")

        self.verify_command.side_effect = response
        key = urlsplit(release.GITHUB_LATEST_FEED).path.lstrip("/")
        self.store.objects[key] = manifest.read_bytes()
        writes = list(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "GitHub latest"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        latest_tag = payload["version"]
        self.store.objects[key] = b"x" * manifest.stat().st_size
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.store.objects[key] = manifest.read_bytes()
        self.publisher.activate(manifest)
        self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())
        self.assertIn(("/" + key, "BeefTV-Desktop-Updater/v1.5.7"), self.public_requests)

class S3AdapterTests(unittest.TestCase):
    def test_r2_configuration_requires_account_endpoint_and_auto_region(self):
        store = release.storage_config("r2", "https://" + "a" * 32 + ".r2.cloudflarestorage.com",
                                       "auto", "beeftv-releases", "https://updates.beefapi.com/beeftv")
        self.assertEqual(store.provider, "r2")
        with self.assertRaises(release.PublishError):
            release.storage_config("r2", "https://" + "a" * 32 + ".r2.cloudflarestorage.com",
                                   "ap-guangzhou", "beeftv-releases", "https://updates.beefapi.com/beeftv")
        with self.assertRaises(release.PublishError):
            release.storage_config("cos", "https://" + "a" * 32 + ".r2.cloudflarestorage.com",
                                   "auto", "beeftv-releases", "https://updates.beefapi.com/beeftv")

    def test_cli_rejects_credential_destination_before_any_command(self):
        for endpoint in ["https://attacker.example", "https://" + "a" * 32 + ".r2.cloudflarestorage.com.evil.example", "https://user@" + "a" * 32 + ".r2.cloudflarestorage.com"]:
            with patch.object(release.sys, "argv", ["publish", "stage", "--manifest", "/tmp/not-read", "--verifier", "/tmp/not-called", "--endpoint-url", endpoint]), patch.object(release, "run") as runner, redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
                runner.assert_not_called()

    def test_put_uses_conditional_write_and_never_passes_credentials(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as runner:
            s3 = release.S3("https://example.r2.cloudflarestorage.com", "beeftv-releases")
            self.assertTrue(s3.put("beeftv/v1.5.7/file.zip", Path("/tmp/file"), release.IMMUTABLE))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-none-match", "*"])
            self.assertTrue(s3.put(release.LATEST, Path("/tmp/feed"), release.REVALIDATE, etag='"old"'))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-match", '"old"'])

    def test_permission_failure_is_not_treated_as_absent(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 1, "", "(AccessDenied) credential")):
            with self.assertRaisesRegex(release.PublishError, "Cannot inspect"):
                release.S3("https://r2.example", "beeftv-releases").get(release.LATEST, "/tmp/unused")


class ConditionalCapabilityTests(unittest.TestCase):
    def store(self, ignore_create=False, ignore_replace=False, ignore_stale=False):
        store = release.S3("https://r2.example", "beeftv-releases")
        fake = FakeS3()
        normal_put = fake.put
        writes = 0

        def put(key, source, cache_control, etag=None):
            nonlocal writes
            writes += 1
            if ((ignore_create and etag is None) or (ignore_replace and etag is not None)
                    or (ignore_stale and writes == 5)):
                fake.objects[key] = Path(source).read_bytes()
                return True
            return normal_put(key, source, cache_control, etag)

        store.put = put
        store.get = fake.get
        store.delete_probe = lambda key: fake.objects.pop(key, None)
        return store, fake

    def test_real_conditional_semantics_pass_and_probe_is_removed(self):
        store, fake = self.store()
        store.check_conditions()
        self.assertEqual(fake.objects, {})
        self.assertTrue(all(key.startswith("beeftv/.publication-probes/") for key, _ in fake.writes))

    def test_ignored_create_and_replacement_conditions_block_and_cleanup(self):
        for flags, error in [(dict(ignore_create=True), "If-None-Match"),
                             (dict(ignore_replace=True), "If-Match"),
                             (dict(ignore_stale=True), "stale")]:
            with self.subTest(flags=flags):
                store, fake = self.store(**flags)
                with self.assertRaisesRegex(release.PublishError, error):
                    store.check_conditions()
                self.assertEqual(fake.objects, {})

    def test_probe_cleanup_cannot_delete_release_assets(self):
        with patch.object(release, "run") as runner, self.assertRaises(release.PublishError):
            release.S3("https://unused", "unused").delete_probe(release.LATEST)
        runner.assert_not_called()

    def test_cleanup_failure_preserves_original_condition_failure(self):
        store, _ = self.store(ignore_create=True)
        store.delete_probe = lambda _: (_ for _ in ()).throw(release.PublishError("cleanup"))
        with self.assertRaisesRegex(release.PublishError, "If-None-Match.*cleanup also failed"):
            store.check_conditions()


if __name__ == "__main__":
    unittest.main()
