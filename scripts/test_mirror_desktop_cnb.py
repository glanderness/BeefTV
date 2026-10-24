import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("cnb", Path(__file__).with_name("mirror-desktop-cnb.py"))
cnb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cnb)


def release(version="v2.0.4"):
    return {"tag_name": version, "html_url": f"https://github.com/glanderness/BeefTV/releases/tag/{version}",
            "assets": [{"name": f"BeefTV-{version}-{platform}{suffix}", "size": 100,
                        "state": "uploaded", "digest": "sha256:" + "a" * 64,
                        "browser_download_url": f"https://github.com/glanderness/BeefTV/releases/download/{version}/BeefTV-{version}-{platform}{suffix}"}
                       for platform, suffix in cnb.PLATFORMS.items()]}


def record(source):
    return {"schema": 1, "repository": cnb.REPO, "version": source["tag_name"], "source": source["html_url"],
            "verification": "anonymous-resume-sha256", "verifiedAt": "2026-10-24T00:00:00Z",
            "assets": cnb.expected_installers(source, source["tag_name"])}


class MirrorTest(unittest.TestCase):
    def test_waits_for_all_official_hashes_without_credentials_on_public_requests(self):
        source = release()
        ready = record(source)
        calls = []
        records = iter([None, ready])
        def fetch(url, payload=None, token=None):
            calls.append((url, payload, token))
            if url == cnb.START:
                self.assertEqual(token, "trigger-only-test")
                self.assertEqual(payload, {"branch": "main", "event": "api_trigger_release", "env": {"BEEFTV_MIRROR_VERSION": "v2.0.4"}})
                return {"success": True}
            self.assertIsNone(token)
            return source if url.startswith(cnb.GITHUB) else next(records)
        sleeps = []
        cnb.mirror("v2.0.4", "trigger-only-test", fetch, sleeps.append)
        self.assertEqual(len(sleeps), 1)
        self.assertEqual(sum(url == cnb.START for url, _, _ in calls), 1)

    def test_invalid_or_incomplete_release_never_triggers(self):
        for change in [{"draft": True}, {"prerelease": True}, {"assets": []}, {"html_url": "https://example.com/"}]:
            source = {**release(), **change}
            seen = []
            def fetch(url):
                seen.append(url)
                return source
            with self.assertRaises(RuntimeError):
                cnb.mirror("v2.0.4", "test", fetch)
            self.assertEqual(seen, [cnb.GITHUB + "v2.0.4"])
        for version, token in [("../v2.0.4", "test"), ("v2.0.2", "test"), ("v2.0.4", "")]:
            with self.assertRaises(RuntimeError):
                cnb.mirror(version, token, lambda *_: self.fail("must not call network"))
        source = release()
        source["assets"][0]["digest"] = None
        with self.assertRaisesRegex(RuntimeError, "Invalid official installer"):
            cnb.expected_installers(source, "v2.0.4")
        with self.assertRaisesRegex(RuntimeError, "another endpoint"):
            cnb.request_json(cnb.PUBLIC + "v2.0.4/beeftv-mirror.json", token="isolated-test")

    def test_mismatched_record_and_rejected_trigger_fail(self):
        source = release()
        bad = record(source)
        bad["assets"][3]["sha256"] = "0" * 64
        def fetch(url, *args):
            return source if url.startswith(cnb.GITHUB) else {"success": True} if url == cnb.START else bad
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            cnb.mirror("v2.0.4", "test", fetch)
        def forbidden(url, *args):
            if url == cnb.START:
                raise RuntimeError("Mirror metadata request: HTTP 403")
            return source
        with self.assertRaisesRegex(RuntimeError, "403"):
            cnb.mirror("v2.0.4", "test", forbidden)

    def test_uncertain_post_is_never_retried_and_missing_record_times_out(self):
        source = release()
        starts = []
        tick = [0]
        def fetch(url, *args):
            if url == cnb.START:
                starts.append(url)
                raise cnb.TriggerUncertain("test")
            return source if url.startswith(cnb.GITHUB) else None
        def sleep(seconds):
            tick[0] += seconds
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            cnb.mirror("v2.0.4", "test", fetch, sleep, lambda: tick[0], timeout=30)
        self.assertEqual(len(starts), 1)


if __name__ == "__main__":
    unittest.main()
