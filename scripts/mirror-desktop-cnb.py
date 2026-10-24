#!/usr/bin/env python3
"""Trigger the CNB mirror and wait for its public verification record."""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

REPO = "beeftv-downloads/desktop"
GITHUB = "https://api.github.com/repos/glanderness/BeefTV/releases/tags/"
START = f"https://api.cnb.cool/{REPO}/-/build/start"
PUBLIC = f"https://cnb.cool/{REPO}/-/releases/download/"
PLATFORMS = {
    "darwin-arm64": ".dmg", "darwin-amd64": ".dmg",
    "windows-amd64": "-setup.exe", "linux-amd64": ".deb",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TriggerUncertain(RuntimeError):
    pass


def request_json(url, payload=None, token=None):
    headers = {"Accept": "application/json", "User-Agent": "BeefTV-Release-Mirror"}
    if token:
        if url != START:
            raise RuntimeError("Refusing to send the trigger credential to another endpoint")
        headers.update(Authorization=f"Bearer {token}", Accept="application/vnd.cnb.api+json")
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    # Public downloads redirect to short-lived object URLs; the credentialed POST cannot redirect.
    handlers = [urllib.request.ProxyHandler({})]
    if token:
        handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=30) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise RuntimeError("Mirror metadata response is too large")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        if error.code == 404 and not token:
            return None
        raise RuntimeError(f"Mirror metadata request: HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError):
        if token:
            raise TriggerUncertain("CNB trigger response was not confirmed") from None
        raise RuntimeError("Mirror metadata request failed") from None
    except ValueError:
        raise RuntimeError("Invalid mirror metadata") from None


def expected_installers(release, version):
    source = f"https://github.com/glanderness/BeefTV/releases/tag/{version}"
    if not release or release.get("tag_name") != version or release.get("draft") or release.get("prerelease") or release.get("html_url") != source:
        raise RuntimeError("Expected a published official release")
    result = []
    for platform, suffix in PLATFORMS.items():
        name = f"BeefTV-{version}-{platform}{suffix}"
        matches = [asset for asset in release.get("assets", []) if asset.get("name") == name]
        if len(matches) != 1:
            raise RuntimeError(f"Missing or duplicate official installer: {platform}")
        asset = matches[0]
        if (asset.get("state") != "uploaded" or type(asset.get("size")) is not int or not 1 < asset["size"] <= 2 * 1024 ** 3
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest", ""))
                or asset.get("browser_download_url") != f"https://github.com/glanderness/BeefTV/releases/download/{version}/{name}"):
            raise RuntimeError(f"Invalid official installer metadata: {platform}")
        result.append({"platform": platform, "name": name, "size": asset["size"], "sha256": asset["digest"][7:]})
    return result


def record_matches(record, release, expected):
    if not isinstance(record, dict) or any(record.get(key) != value for key, value in {
        "schema": 1, "repository": REPO, "version": release["tag_name"],
        "source": release["html_url"], "verification": "anonymous-resume-sha256",
    }.items()):
        return False
    try:
        datetime.datetime.fromisoformat(record["verifiedAt"].replace("Z", "+00:00"))
        assets = record["assets"]
        return (len(assets) == len(expected) and all(isinstance(asset, dict) for asset in assets)
                and all(sum(all(asset.get(key) == value for key, value in item.items()) for asset in assets) == 1 for item in expected))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def mirror(version, token, fetch=request_json, sleep=time.sleep, now=time.monotonic, timeout=2400):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", version) or tuple(map(int, version[1:].split("."))) < (2, 0, 3):
        raise RuntimeError("Expected a version at or after v2.0.3")
    if not token:
        raise RuntimeError("Missing repository secret BEEFTV_CNB_TRIGGER_TOKEN")
    release = fetch(GITHUB + version)
    expected = expected_installers(release, version)
    # Issue one POST only. An uncertain response may already have started the job.
    try:
        started = fetch(START, {"branch": "main", "event": "api_trigger_release", "env": {"BEEFTV_MIRROR_VERSION": version}}, token)
        if not isinstance(started, dict) or started.get("success") is not True:
            raise RuntimeError("CNB did not accept the mirror trigger")
    except TriggerUncertain:
        print("CNB trigger response was not confirmed; checking the public verification record without retriggering.")
    deadline = now() + timeout
    while now() < deadline:
        try:
            record = fetch(PUBLIC + version + "/beeftv-mirror.json")
            if record_matches(record, release, expected):
                print(f"CNB mirror verified: {version} (all four official installer hashes match)")
                return
            if record is not None:
                raise RuntimeError("CNB verification record does not match the official release")
        except RuntimeError as error:
            if str(error).startswith("CNB verification"):
                raise
        sleep(min(15, max(0, deadline - now())))
    raise RuntimeError("CNB mirror was not verified before timeout; its website links remain hidden. Retry only the mirror job, not the desktop release.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        mirror(args.version, os.environ.get("BEEFTV_CNB_TRIGGER_TOKEN"))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
