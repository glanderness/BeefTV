"""Contract tests for scripts/package-desktop-release.sh across all 4 desktop platforms."""

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


SCRIPT_SOURCE = Path(__file__).with_name("package-desktop-release.sh")


class PackageDesktopReleaseScriptTests(unittest.TestCase):
    def make_fixture_repo(self, root: Path):
        (root / "scripts").mkdir(parents=True)
        (root / "backend").mkdir(parents=True)
        (root / "bin").mkdir(parents=True)
        target_script = root / "scripts" / "package-desktop-release.sh"
        shutil.copy2(SCRIPT_SOURCE, target_script)
        target_script.chmod(target_script.stat().st_mode | stat.S_IXUSR)

        for stub_name in ("package-desktop-installer.py", "smoke-packaged-cli_test.py", "smoke-packaged-cli.py"):
            (root / "scripts" / stub_name).write_text(
                "import json, os, sys\n"
                "with open(os.environ['TEST_CALL_LOG'], 'a', encoding='utf-8') as f:\n"
                "    f.write(json.dumps({'tool': '" + stub_name + "', 'argv': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')\n"
                "if '" + stub_name + "' == 'package-desktop-installer.py' and os.environ.get('FAIL_INSTALLER') == '1':\n"
                "    sys.exit(7)\n",
                encoding="utf-8",
            )

        go_stub = root / "bin" / "go"
        go_stub.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "with open(os.environ['TEST_CALL_LOG'], 'a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps({'tool': 'go', 'argv': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')\n"
            "if '--output' in sys.argv:\n"
            "    out = pathlib.Path(sys.argv[sys.argv.index('--output') + 1])\n"
            "    out.parent.mkdir(parents=True, exist_ok=True)\n"
            "    out.write_bytes(b'zip-bytes')\n"
            "if 'verify' in sys.argv and os.environ.get('FAIL_PREV_VERIFY') == '1':\n"
            "    sys.exit(1)\n",
            encoding="utf-8",
        )
        go_stub.chmod(0o755)

        curl_stub = root / "bin" / "curl"
        curl_stub.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "with open(os.environ['TEST_CALL_LOG'], 'a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps({'tool': 'curl', 'argv': sys.argv[1:]}) + '\\n')\n"
            "if os.environ.get('FAIL_PREV_CURL') == '1':\n"
            "    sys.exit(22)\n"
            "if '-o' in sys.argv:\n"
            "    out = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n"
            "    out.parent.mkdir(parents=True, exist_ok=True)\n"
            "    out.write_bytes(b'downloaded')\n",
            encoding="utf-8",
        )
        curl_stub.chmod(0o755)
        return target_script

    def run_script(self, extra_env):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = self.make_fixture_repo(root)
            log_file = root / "calls.jsonl"
            runner_temp = root / "runner-temp"
            runner_temp.mkdir()
            env = {
                **os.environ,
                "PATH": f"{root / 'bin'}:{os.environ['PATH']}",
                "TEST_CALL_LOG": str(log_file),
                "RUNNER_TEMP": str(runner_temp),
                "VERSION": "v2.4.0",
                "UPDATER_DOWNLOAD_BASE": "https://updates.beefapi.com/beeftv",
                "BEEFTV_UPDATER_PUBLIC_KEY": "fixture-pub-key",
                **extra_env,
            }
            result = subprocess.run(["bash", str(script)], cwd=root / "backend", env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines()] if log_file.exists() else []
            leftover_temp = list(runner_temp.iterdir())
            dist_files = sorted(p.name for p in (root / "dist").iterdir()) if (root / "dist").exists() else []
            return result, calls, dist_files, leftover_temp

    def test_platform_inputs_delta_build_and_cli_smoke_across_all_targets(self):
        expected_inputs = {
            "darwin-arm64": "cmd/desktop/build/bin/BeefTV.app",
            "darwin-amd64": "cmd/desktop/build/bin/BeefTV.app",
            "linux-amd64": "cmd/desktop/build/bin/BeefTV-linux",
            "windows-amd64": "cmd/desktop/build/bin",
        }
        for platform, expected_input in expected_inputs.items():
            with self.subTest(platform=platform):
                result, calls, dist_files, leftover_temp = self.run_script({"PLATFORM": platform, "PREVIOUS_VERSION": "v2.3.1"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(leftover_temp, [])
                self.assertEqual(
                    dist_files,
                    sorted([
                        f"BeefTV-v2.4.0-{platform}.zip",
                        f"BeefTV-v2.4.0-{platform}-from-v2.3.1.delta.zip",
                    ]),
                )
                go_calls = [c["argv"] for c in calls if c["tool"] == "go"]
                self.assertEqual(
                    go_calls[0],
                    ["run", "./cmd/update-release", "package", "--platform", platform, "--input", expected_input, "--output", f"../dist/BeefTV-v2.4.0-{platform}.zip"],
                )
                self.assertEqual(go_calls[1][:3], ["run", "./cmd/update-release", "verify"])
                self.assertEqual(go_calls[2][:3], ["run", "./cmd/update-release", "build-delta"])
                smoke_calls = [c for c in calls if c["tool"] in ("smoke-packaged-cli_test.py", "smoke-packaged-cli.py")]
                self.assertEqual([c["tool"] for c in smoke_calls], ["smoke-packaged-cli_test.py", "smoke-packaged-cli.py"])

    def test_unavailable_previous_release_warns_and_still_succeeds_without_delta(self):
        result, _, dist_files, leftover_temp = self.run_script(
            {"PLATFORM": "windows-amd64", "PREVIOUS_VERSION": "v2.3.1", "FAIL_PREV_CURL": "1"}
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("::warning::Previous release v2.3.1 windows-amd64 zip unavailable", result.stdout)
        self.assertEqual(dist_files, ["BeefTV-v2.4.0-windows-amd64.zip"])
        self.assertEqual(leftover_temp, [])

    def test_installer_failure_aborts_before_cli_smoke_and_cleans_temp(self):
        result, calls, _, leftover_temp = self.run_script({"PLATFORM": "linux-amd64", "FAIL_INSTALLER": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Native installer packaging failed", result.stdout)
        self.assertFalse(any(c["tool"] == "smoke-packaged-cli.py" for c in calls))
        self.assertEqual(leftover_temp, [])

    def test_unknown_platform_is_rejected(self):
        result, _, _, leftover_temp = self.run_script({"PLATFORM": "freebsd-amd64"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported desktop release platform", result.stdout)
        self.assertEqual(leftover_temp, [])


if __name__ == "__main__":
    unittest.main()
