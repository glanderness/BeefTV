#!/usr/bin/env python3
"""在独立临时副本复放未改 850 的 N1，再验证指定修正提交；不运行全套。"""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile

BASELINE = "850d89c109b7e94a356834ee51eedba6dba019fb"
EVIDENCE = "docs/implementation/evidence/generation-task-state-step-3/r2-fix"
N1 = "^(TestOpusR2Image(NoResult|Unrecoverable)RetryCanRequeue|TestStep3Image(RefundRetryAfterResultConclusion|ConclusionWithoutRefundDoesNotRequeue))$"
ADJACENT = "^(TestRetryAcceptedImageUsesOriginalReceiptWithoutCreate|TestImageReceiptRecoveryRejectsAmbiguousAndFailedCreates|TestAutomaticImageRecoveryConclusions|TestImageSubmissionUnknownProviderCannotReplayOrRetryLostResponse|TestImageSubmissionCountErrorCannotErasePriorAcceptance|TestStep3ImageJobTerminalConclusionAndResultJSON|TestStep3FreeReplayReadsCurrentTask|TestStep3PaidRetryReplayAfterDatabaseReopenAndNewRun|TestReviewFreeRecoveryRunningReceiptAfterCrash|TestReviewFreeRecoveryReceiptRecordsRouteRuns|TestStep3ConcurrentRetryHTTPAndConflictingTask|TestReviewPaidRetryWithOperationIDRequeuesOnceAndReplays|TestWorkflowAcceptedNotRecordedMapsToUnknownBlocksRetryAndKeepsID)$"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="包含两个固定 Git 对象的仓库")
    parser.add_argument("--candidate", required=True, help="待核验修正提交的完整 SHA")
    parser.add_argument("--plugins", type=Path, required=True, help="已物化的官方协议包目录，只读复用")
    parser.add_argument("--output", type=Path, required=True, help="新的输出目录，避免覆盖原件")
    args = parser.parse_args()
    repo, plugins, output = args.repo.resolve(), args.plugins.resolve(), args.output.resolve()
    if not plugins.is_dir():
        raise SystemExit("缺少官方协议包目录，先补齐环境，不能把环境失败当作产品反例")

    def git(*command):
        return subprocess.check_output(["git", "-C", str(repo), *command])

    candidate = git("rev-parse", "--verify", args.candidate + "^{commit}").decode().strip()
    git("cat-file", "-e", BASELINE + "^{commit}")
    output.mkdir(parents=True, exist_ok=False)
    (output / ".gitattributes").write_text("*.txt -text -eol\n")
    env = os.environ.copy()
    for key in ("TDS_TEAM_API_KEY", "WEBCAFE_TOKEN", "YUN"):
        env.pop(key, None)
    env["CANVAS_OFFICIAL_PLUGIN_DIR"] = str(plugins)
    (output / "environment.json").write_text(json.dumps({
        "platform": platform.platform(), "cpu_count": os.cpu_count(),
        "go_version": subprocess.check_output(["go", "version"]).decode().strip(),
        "baseline": BASELINE, "candidate": candidate, "plugins": str(plugins),
    }, ensure_ascii=False, indent=2) + "\n")

    overlay = {
        "backend/internal/app/opus_r2_external_test.go": EVIDENCE + "/input/opus_r2_test.go.txt",
        "backend/internal/app/opus_r2_n1_unrecoverable_external_test.go": EVIDENCE + "/input/opus_r2_n1_unrecoverable_test.go.txt",
        "backend/internal/app/step3_image_retry_after_refund_test.go": "backend/internal/app/step3_image_retry_after_refund_test.go",
    }

    def run(name, folder, command, expected):
        meta = {"command": command, "expected_exit": expected, "started": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        with (output / (name + ".txt")).open("wb") as log:
            process = subprocess.Popen(command, cwd=folder / "backend", env=env, stdout=log, stderr=subprocess.STDOUT)
            meta["pid"] = process.pid
            (output / (name + ".json")).write_text(json.dumps(meta, indent=2) + "\n")
            meta["exit"] = process.wait()
        meta["finished"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        raw = (output / (name + ".txt")).read_bytes()
        meta["sha256"] = hashlib.sha256(raw).hexdigest()
        (output / (name + ".json")).write_text(json.dumps(meta, indent=2) + "\n")
        if meta["exit"] != expected or b"=== RUN" not in raw or b"[build failed]" in raw:
            raise SystemExit(f"{name}: 未得到预期运行结果，详见原始输出")
        if expected == 1 and b"--- FAIL: TestOpusR2ImageNoResultRetryCanRequeue" not in raw:
            raise SystemExit("未运行到原 N1 反例，不能把编译或环境失败当作先红")
        print(json.dumps({"check": name, "exit": meta["exit"]}), flush=True)

    with tempfile.TemporaryDirectory(prefix="step3-n1-") as temporary:
        for label, commit in (("unchanged-850", BASELINE), ("candidate", candidate)):
            folder = Path(temporary) / label
            folder.mkdir()
            archive = git("archive", commit, "backend")
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(folder, filter="data")
            product = {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (folder / "backend").rglob("*") if p.is_file()}
            added = {}
            for destination, source in overlay.items():
                data = git("show", candidate + ":" + source)
                (folder / destination).write_bytes(data)
                added[destination] = {"source": source, "sha256": hashlib.sha256(data).hexdigest()}
            (output / (label + "-sources.json")).write_text(json.dumps({"product_commit": commit, "product_before_test_overlay": product, "test_overlay": added}, indent=2) + "\n")
            run(label + "-n1", folder, ["go", "test", "./internal/app", "-run", N1, "-count=1", "-timeout=5m", "-v"], 1 if label == "unchanged-850" else 0)
            if label == "candidate":
                run("candidate-adjacent", folder, ["go", "test", "./internal/app", "./internal/handler", "-run", ADJACENT, "-count=1", "-timeout=5m", "-v"], 0)


if __name__ == "__main__":
    main()
