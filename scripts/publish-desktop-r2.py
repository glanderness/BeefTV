#!/usr/bin/env python3
"""Publish signed desktop releases to R2.

stage uploads immutable version objects; activate requires a published GitHub
release and atomically changes latest after public verification. Credentials stay
in AWS environment variables. No bucket configuration or permissions are changed.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit
import uuid

PLATFORMS = {"darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64"}
PREFIX = "beeftv"
LATEST = f"{PREFIX}/desktop-update.json"
LATEST_V2 = f"{PREFIX}/desktop-update-v2.json"
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-store, max-age=0"
MAX_MANIFEST = 2 * 1024 * 1024
GITHUB_LATEST_FEED = "https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json"
R2_PUBLIC_BASE = "https://updates.beefapi.com/beeftv"
CNB_PUBLIC_BASE = "https://cnb.cool/beeftv-downloads/desktop/-/releases/download"


class PublishError(Exception):
    pass


def fingerprint(path):
    digest, size = hashlib.sha256(), 0
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise PublishError("Expected a stable vMAJOR.MINOR.PATCH version")
    return tuple(map(int, version[1:].split(".")))


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=600,
                              env={**os.environ, "AWS_PAGER": "", "AWS_EC2_METADATA_DISABLED": "true",
                                   "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
                                   "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required"})
    except (OSError, subprocess.TimeoutExpired):
        raise PublishError("Required release command unavailable or timed out") from None


def signed_payload(path, verifier):
    if Path(path).stat().st_size > MAX_MANIFEST:
        raise PublishError("Manifest is too large")
    # The Go verifier reads BEEFTV_UPDATER_PUBLIC_KEY itself; no key in argv/logs.
    result = run([str(verifier), "verify", "--envelope", str(path)])
    if result.returncode:
        raise PublishError("Manifest signature or schema verification failed")
    try:
        envelope = json.loads(Path(path).read_bytes())
        payload = json.loads(base64.b64decode(envelope["payload"], validate=True))
        version_tuple(payload["version"])
        return payload
    except (ValueError, KeyError, TypeError):
        raise PublishError("Invalid signed manifest payload") from None


class S3:
    def __init__(self, endpoint, bucket):
        self.base = ["aws", "--endpoint-url", endpoint, "--region", "auto", "s3api"]
        self.bucket = bucket
        self.provider = "r2"

    def get(self, key, destination):
        head = run(self.base + ["head-object", "--bucket", self.bucket, "--key", key])
        if head.returncode:
            if re.search(r"\((404|NoSuchKey|NotFound)\)", head.stderr):
                return None
            raise PublishError(f"Cannot inspect release object: {key}")
        etag = json.loads(head.stdout)["ETag"]
        result = run(self.base + ["get-object", "--bucket", self.bucket, "--key", key,
                                  "--if-match", etag, str(destination)])
        if result.returncode:
            raise PublishError(f"Cannot read stable release object: {key}")
        return etag

    def put(self, key, source, cache_control, etag=None):
        condition = ["--if-match", etag] if etag else ["--if-none-match", "*"]
        result = run(self.base + ["put-object", "--bucket", self.bucket, "--key", key,
                                  "--body", str(source), "--cache-control", cache_control,
                                  "--content-type", {".json": "application/json", ".zip": "application/zip", ".dmg": "application/x-apple-diskimage", ".exe": "application/vnd.microsoft.portable-executable", ".deb": "application/vnd.debian.binary-package"}.get(Path(key).suffix, "application/octet-stream")] + condition)
        if result.returncode:
            if re.search(r"\((412|PreconditionFailed|ConditionalRequestConflict)\)", result.stderr):
                return False
            raise PublishError(f"Conditional release upload failed: {key}")
        return True

    def delete_probe(self, key):
        if not key.startswith(f"{PREFIX}/.publication-probes/"):
            raise PublishError("Refusing to delete a release object")
        if run(self.base + ["delete-object", "--bucket", self.bucket, "--key", key]).returncode:
            raise PublishError("Conditional-write probe cleanup failed")

    def check_conditions(self):
        """Detect S3 implementations that ignore conditional PUT headers."""
        key = f"{PREFIX}/.publication-probes/{uuid.uuid4().hex}"
        with tempfile.TemporaryDirectory(prefix="beeftv-store-probe-") as directory:
            first, second, readback = (Path(directory) / name for name in ("first", "second", "readback"))
            first.write_bytes(b"BeefTV conditional-write probe A")
            second.write_bytes(b"BeefTV conditional-write probe B")
            try:
                if not self.put(key, first, REVALIDATE):
                    raise PublishError("Cannot create conditional-write probe")
                etag = self.get(key, readback)
                if etag is None or fingerprint(readback) != fingerprint(first):
                    raise PublishError("Conditional-write probe readback failed")
                if self.put(key, second, REVALIDATE):
                    raise PublishError("Storage ignores If-None-Match; publication is blocked")
                if self.put(key, second, REVALIDATE, etag='"beeftv-invalid-etag"'):
                    raise PublishError("Storage ignores If-Match; activation is blocked")
                if self.get(key, readback) != etag or fingerprint(readback) != fingerprint(first):
                    raise PublishError("Rejected conditional writes changed stored bytes")
                if not self.put(key, second, REVALIDATE, etag=etag):
                    raise PublishError("Storage rejects valid If-Match; activation is blocked")
                if self.get(key, readback) is None or fingerprint(readback) != fingerprint(second):
                    raise PublishError("Conditional replacement readback failed")
                # A stale ETag must still be rejected after a successful replace.
                if self.put(key, first, REVALIDATE, etag=etag):
                    raise PublishError("Storage accepts stale If-Match; activation is blocked")
                if self.get(key, readback) is None or fingerprint(readback) != fingerprint(second):
                    raise PublishError("Rejected stale write changed stored bytes")
            finally:
                failure = sys.exc_info()[1]
                try:
                    self.delete_probe(key)
                except PublishError:
                    if failure is not None:
                        raise PublishError(f"{failure}; conditional-write probe cleanup also failed") from None
                    raise


class PublicHTTP:
    def __init__(self, opener=urllib.request.urlopen):
        self.opener = opener

    def check(self, url, expected_size, expected_hash, *, version):
        version_tuple(version)
        digest = hashlib.sha256()
        size = 0
        try:
            headers = {"Cache-Control": "no-cache", "User-Agent": f"BeefTV-Desktop-Updater/{version}"}
            request = urllib.request.Request(url, headers=headers)
            with self.opener(request, timeout=60) as response:
                if response.status != 200:
                    raise PublishError("Public object did not return HTTP 200")
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise PublishError("Public object size mismatch")
                    digest.update(chunk)
        except (OSError, ValueError, http.client.HTTPException):
            raise PublishError("Public object readback failed") from None
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise PublishError("Public object size/hash mismatch")


def require_github_release(payload, manifest, public):
    result = run(["gh", "api", f"repos/glanderness/BeefTV/releases/tags/{payload['version']}"])
    if result.returncode:
        raise PublishError("Cannot verify published GitHub release")
    release = json.loads(result.stdout)
    if (release.get("draft") is not False or release.get("prerelease") is not False
            or not release.get("published_at") or release.get("tag_name") != payload["version"]
            or release.get("target_commitish") != payload["commit"]):
        raise PublishError("GitHub release is not published for this exact commit")
    expected = {f"BeefTV-{payload['version']}-{platform}.zip" for platform in PLATFORMS}
    expected.add("desktop-update.json")
    uploaded = {asset.get("name") for asset in release.get("assets", []) if asset.get("state") == "uploaded"}
    if not expected.issubset(uploaded):
        raise PublishError("GitHub release assets are incomplete")
    latest = run(["gh", "api", "repos/glanderness/BeefTV/releases/latest"])
    if latest.returncode or json.loads(latest.stdout).get("tag_name") != payload["version"]:
        raise PublishError("GitHub latest does not point to this version")
    public.check(GITHUB_LATEST_FEED, *fingerprint(manifest), version=payload["version"])


class Publisher:
    def __init__(self, store, public, verifier, public_base, release_check=require_github_release):
        self.store, self.public, self.verifier = store, public, verifier
        self.public_base = public_base.rstrip("/")
        self.release_check = release_check

    def load(self, manifest):
        payload = signed_payload(manifest, self.verifier)
        if payload.get("schema") != 1:
            raise PublishError("Legacy manifest must use schema 1")
        if set(payload["platforms"]) != PLATFORMS:
            raise PublishError("Manifest must contain exactly all four desktop platforms")
        for platform, asset in payload["platforms"].items():
            name = f"BeefTV-{payload['version']}-{platform}.zip"
            if "urls" in asset or "deltas" in asset or asset.get("url") != f"{self.public_base}/{payload['version']}/{name}":
                raise PublishError("Manifest asset URL does not match immutable public version path")
            if type(asset["size"]) is not int or not 0 < asset["size"] <= 2 << 30:
                raise PublishError("Invalid desktop archive size")
            if not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
                raise PublishError("Invalid desktop archive hash")
        return payload

    def load_v2(self, manifest):
        payload = signed_payload(manifest, self.verifier)
        if payload.get("schema") != 2 or set(payload["platforms"]) != PLATFORMS:
            raise PublishError("Manifest v2 must use schema 2 and contain all four desktop platforms")
        target_vtuple = version_tuple(payload["version"])
        url_counts = set()
        delta_key_sets = set()
        for platform, asset in payload["platforms"].items():
            name = f"BeefTV-{payload['version']}-{platform}.zip"
            r2_url = f"{self.public_base}/{payload['version']}/{name}"
            cnb_url = f"{CNB_PUBLIC_BASE}/{payload['version']}/{name}"
            urls = asset.get("urls")
            if "url" in asset or urls not in ([r2_url], [cnb_url, r2_url]):
                raise PublishError("Manifest v2 asset URLs must be [r2] or [cnb, r2]")
            url_counts.add(len(urls))
            if type(asset["size"]) is not int or not 0 < asset["size"] <= 2 << 30:
                raise PublishError("Invalid desktop archive size")
            if not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
                raise PublishError("Invalid desktop archive hash")
            deltas = asset.get("deltas") or {}
            if not isinstance(deltas, dict):
                raise PublishError("Manifest v2 deltas must be an object")
            delta_key_sets.add(frozenset(deltas.keys()))
            for from_ver, delta in deltas.items():
                if version_tuple(from_ver) >= target_vtuple or not isinstance(delta, dict):
                    raise PublishError("Manifest v2 delta fromVersion must be an older stable version")
                d_name = f"BeefTV-{payload['version']}-{platform}-from-{from_ver}.delta.zip"
                d_r2_url = f"{self.public_base}/{payload['version']}/{d_name}"
                d_cnb_url = f"{CNB_PUBLIC_BASE}/{payload['version']}/{d_name}"
                expected_d_urls = [d_r2_url] if len(urls) == 1 else [d_cnb_url, d_r2_url]
                if delta.get("urls") != expected_d_urls:
                    raise PublishError("Manifest v2 delta URLs must match platform source set")
                if type(delta.get("size")) is not int or not 0 < delta["size"] <= asset["size"]:
                    raise PublishError("Invalid desktop delta archive size")
                if not re.fullmatch(r"[a-f0-9]{64}", str(delta.get("sha256", ""))):
                    raise PublishError("Invalid desktop delta archive hash")
        if len(url_counts) != 1 or len(delta_key_sets) != 1:
            raise PublishError("Manifest v2 platforms must all share the same source and delta set")
        return payload

    def immutable_put(self, key, source):
        expected = fingerprint(source)
        with tempfile.TemporaryDirectory(prefix="beeftv-release-check-") as directory:
            previous = Path(directory) / "object"
            etag = self.store.get(key, previous)
            if etag is None:
                self.store.put(key, source, IMMUTABLE)
                # Read back our upload or the immutable create another publisher won.
                etag = self.store.get(key, previous)
            if etag is None or fingerprint(previous) != expected:
                raise PublishError(f"Immutable version object already differs: {key}")

    def public_check(self, payload, manifest):
        for asset in payload["platforms"].values():
            self.public.check(asset["url"], asset["size"], asset["sha256"], version=payload["version"])
        size, sha = fingerprint(manifest)
        self.public.check(f"{self.public_base}/{payload['version']}/desktop-update.json", size, sha, version=payload["version"])

    def installer_sources(self, payload, assets_dir):
        suffixes = {"darwin-arm64": ".dmg", "darwin-amd64": ".dmg",
                    "windows-amd64": "-setup.exe", "linux-amd64": ".deb"}
        sources = []
        for platform, suffix in suffixes.items():
            name = f"BeefTV-{payload['version']}-{platform}{suffix}"
            source = Path(assets_dir) / name
            if not source.is_file() or source.stat().st_size == 0:
                raise PublishError(f"Installer missing: {name}")
            sources.append((f"{PREFIX}/{payload['version']}/{name}", source))
        return sources

    def check_installers(self, payload, sources):
        for key, source in sources:
            self.public.check(f"{self.public_base}/{payload['version']}/{source.name}",
                              *fingerprint(source), version=payload['version'])

    def stage(self, manifest, assets_dir, with_installers=False, manifest_v2=None):
        payload = self.load(manifest)
        sources = []
        for platform, asset in payload["platforms"].items():
            name = f"BeefTV-{payload['version']}-{platform}.zip"
            source = Path(assets_dir) / name
            if not source.is_file() or fingerprint(source) != (asset["size"], asset["sha256"]):
                raise PublishError(f"Local archive missing or size/hash mismatch: {name}")
            sources.append((f"{PREFIX}/{payload['version']}/{name}", source))
        delta_sources = []
        if manifest_v2 is not None:
            v2_payload = self.load_v2(manifest_v2)
            if v2_payload["version"] != payload["version"] or v2_payload["commit"] != payload["commit"]:
                raise PublishError("Staged manifest v2 metadata does not match manifest v1")
            for platform, asset in v2_payload["platforms"].items():
                for from_ver, delta in (asset.get("deltas") or {}).items():
                    d_name = f"BeefTV-{payload['version']}-{platform}-from-{from_ver}.delta.zip"
                    d_source = Path(assets_dir) / d_name
                    if not d_source.is_file() or fingerprint(d_source) != (delta["size"], delta["sha256"]):
                        raise PublishError(f"Local delta archive missing or size/hash mismatch: {d_name}")
                    delta_sources.append((f"{PREFIX}/{payload['version']}/{d_name}", d_source, delta))
        installers = self.installer_sources(payload, assets_dir) if with_installers else []
        # One at a time: with four parallel uploads an aws command hung until its 10-minute limit.
        for key, source in sources + [(k, s) for k, s, _ in delta_sources] + installers:
            self.immutable_put(key, source)
        self.check_installers(payload, installers)
        for _, d_source, delta in delta_sources:
            self.public.check(f"{self.public_base}/{payload['version']}/{d_source.name}",
                              delta["size"], delta["sha256"], version=payload["version"])
        self.immutable_put(f"{PREFIX}/{payload['version']}/desktop-update.json", manifest)
        self.public_check(payload, manifest)
        return payload["version"]

    def activate(self, manifest, installer_dir=None):
        payload = self.load(manifest)
        if installer_dir is not None:
            self.check_installers(payload, self.installer_sources(payload, installer_dir))
        self.release_check(payload, manifest, self.public)
        self.public_check(payload, manifest)
        with tempfile.TemporaryDirectory(prefix="beeftv-release-latest-") as directory:
            previous = Path(directory) / "previous.json"
            etag = self.store.get(LATEST, previous)
            if etag is not None:
                old = signed_payload(previous, self.verifier)
                if version_tuple(old["version"]) > version_tuple(payload["version"]):
                    raise PublishError("Refusing to downgrade latest")
                if version_tuple(old["version"]) == version_tuple(payload["version"]):
                    if fingerprint(previous) != fingerprint(manifest):
                        raise PublishError("Same latest version has different signed content")
                    self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
                    return payload["version"]
                backup = f"{PREFIX}/latest-backups/{old['version']}-{fingerprint(previous)[1]}.json"
                self.immutable_put(backup, previous)
            if not self.store.put(LATEST, manifest, REVALIDATE, etag=etag):
                raise PublishError("Latest changed concurrently; verify and rerun activation")
            # Check both authoritative storage and the public feed after the atomic PUT.
            current = Path(directory) / "current.json"
            if self.store.get(LATEST, current) is None or fingerprint(current) != fingerprint(manifest):
                raise PublishError("Latest storage readback mismatch")
            self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
        return payload["version"]

    def activate_v2(self, manifest):
        if getattr(self.store, "provider", "r2") != "r2" or self.public_base != R2_PUBLIC_BASE:
            raise PublishError("Manifest v2 publication is only supported on canonical R2")
        payload = self.load_v2(manifest)
        with tempfile.TemporaryDirectory(prefix="beeftv-release-latest-v2-") as directory:
            active_v1 = Path(directory) / "active-v1.json"
            if self.store.get(LATEST, active_v1) is None:
                raise PublishError("R2 canonical v1 feed must be active before publishing v2 feed")
            v1_payload = self.load(active_v1)
            if (v1_payload["version"] != payload["version"] or v1_payload["commit"] != payload["commit"]
                    or v1_payload["notes"] != payload["notes"]):
                raise PublishError("Manifest v2 metadata does not match active R2 v1 feed")
            for platform, asset in payload["platforms"].items():
                v1_asset = v1_payload["platforms"][platform]
                if (asset["size"], asset["sha256"]) != (v1_asset["size"], v1_asset["sha256"]):
                    raise PublishError(f"Manifest v2 digest/size mismatch against active v1 feed: {platform}")
            self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(active_v1),
                              version=payload["version"])
            for asset in payload["platforms"].values():
                for url in asset["urls"]:
                    self.public.check(url, asset["size"], asset["sha256"], version=payload["version"])
                for delta in (asset.get("deltas") or {}).values():
                    for url in delta["urls"]:
                        self.public.check(url, delta["size"], delta["sha256"], version=payload["version"])
            has_domestic = any(len(a["urls"]) == 2 for a in payload["platforms"].values())
            version_manifest_name = "desktop-update-v2.json" if has_domestic else "desktop-update-v2-r2.json"
            self.immutable_put(f"{PREFIX}/{payload['version']}/{version_manifest_name}", manifest)
            self.public.check(f"{self.public_base}/{payload['version']}/{version_manifest_name}",
                              *fingerprint(manifest), version=payload["version"])
            previous = Path(directory) / "previous-v2.json"
            etag = self.store.get(LATEST_V2, previous)
            if etag is not None:
                old = self.load_v2(previous)
                if version_tuple(old["version"]) > version_tuple(payload["version"]):
                    raise PublishError("Refusing to downgrade latest v2 feed")
                if version_tuple(old["version"]) == version_tuple(payload["version"]):
                    if fingerprint(previous) == fingerprint(manifest):
                        self.public.check(f"{self.public_base}/desktop-update-v2.json",
                                          *fingerprint(manifest), version=payload["version"])
                        return payload["version"]
                    old_has_domestic = any(len(a["urls"]) == 2 for a in old["platforms"].values())
                    if old_has_domestic or not has_domestic:
                        raise PublishError("Same latest v2 version has conflicting signed content")
                    for platform, asset in payload["platforms"].items():
                        old_deltas = old["platforms"][platform].get("deltas") or {}
                        new_deltas = asset.get("deltas") or {}
                        if {k: (v["size"], v["sha256"]) for k, v in old_deltas.items()} != {k: (v["size"], v["sha256"]) for k, v in new_deltas.items()}:
                            raise PublishError(f"Same latest v2 version has conflicting delta digests: {platform}")
                backup = f"{PREFIX}/latest-v2-backups/{old['version']}-{fingerprint(previous)[1]}.json"
                self.immutable_put(backup, previous)
            if not self.store.put(LATEST_V2, manifest, REVALIDATE, etag=etag):
                raise PublishError("Latest v2 feed changed concurrently; verify and rerun activation")
            current = Path(directory) / "current-v2.json"
            if self.store.get(LATEST_V2, current) is None or fingerprint(current) != fingerprint(manifest):
                raise PublishError("Latest v2 storage readback mismatch")
            self.public.check(f"{self.public_base}/desktop-update-v2.json",
                              *fingerprint(manifest), version=payload["version"])
        return payload["version"]


def storage_config(provider, endpoint, region, bucket, public_base):
    for url in (endpoint, public_base):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.port is not None):
            raise PublishError("Release endpoint and public base must be plain HTTPS URLs")
    if provider != "r2":
        raise PublishError("Unsupported release storage provider")
    if not re.fullmatch(r"https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com/?", endpoint) or region != "auto":
        raise PublishError("R2 credentials require an account R2 endpoint and auto region")
    return S3(endpoint, bucket)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check-store", "stage", "activate", "activate-v2"])
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--manifest-v2", type=Path, help="Optional schema-2 manifest whose delta archives should be staged with stage")
    parser.add_argument("--assets-dir", type=Path)
    parser.add_argument("--with-installers", action="store_true")
    parser.add_argument("--verifier", type=Path, help="Binary built from backend/cmd/update-release")
    parser.add_argument("--provider", choices=["r2"], default="r2")
    parser.add_argument("--endpoint-url", required=True)
    parser.add_argument("--region")
    parser.add_argument("--bucket")
    parser.add_argument("--public-base")
    args = parser.parse_args()
    args.region = args.region or "auto"
    args.bucket = args.bucket or "beeftv-releases"
    args.public_base = args.public_base or R2_PUBLIC_BASE
    try:
        if args.command == "activate-v2" and (args.provider != "r2" or args.with_installers):
            raise PublishError("activate-v2 requires R2 provider and no installer staging")
        store = storage_config(args.provider, args.endpoint_url, args.region, args.bucket, args.public_base)
        if args.command != "check-store" and (args.manifest is None or args.verifier is None):
            raise PublishError("Publication requires --manifest and --verifier")
        # Prove R2 native conditional PUT headers before publishing; never assume
        # an S3-compatible endpoint enforces If-None-Match / If-Match.
        store.check_conditions()
        if args.command == "check-store":
            print("Release storage conditional writes verified")
            return 0
        # Snapshot the verified envelope so a changed local file cannot be activated.
        with tempfile.TemporaryDirectory(prefix="beeftv-release-manifest-") as directory:
            manifest = Path(directory) / "desktop-update.json"
            if args.manifest.stat().st_size > MAX_MANIFEST:
                raise PublishError("Manifest is too large")
            manifest.write_bytes(args.manifest.read_bytes())
            manifest_v2 = None
            if args.manifest_v2 is not None:
                if args.command != "stage":
                    raise PublishError("--manifest-v2 is only supported for stage")
                if args.manifest_v2.stat().st_size > MAX_MANIFEST:
                    raise PublishError("Manifest v2 is too large")
                manifest_v2 = Path(directory) / "desktop-update-v2.json"
                manifest_v2.write_bytes(args.manifest_v2.read_bytes())
            publisher = Publisher(store, PublicHTTP(), args.verifier.resolve(), args.public_base)
            assets_dir = args.assets_dir or args.manifest.parent
            if args.command == "stage":
                version = publisher.stage(manifest, assets_dir, args.with_installers, manifest_v2=manifest_v2)
            elif args.command == "activate-v2":
                version = publisher.activate_v2(manifest)
            else:
                version = publisher.activate(manifest, assets_dir if args.with_installers else None)
        print(f"{args.command} verified: {version}")
    except PublishError as error:
        print(f"Desktop publication failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        # Never include subprocess stderr, request headers or credential-bearing URLs.
        print("Desktop publication failed; latest was not verified. Inspect release inputs and storage state before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
