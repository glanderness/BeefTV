#!/usr/bin/env python3
"""用固定源码生成 v26/v27 隔离库，复放第 3 步失败或当前验证。"""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

BASE = "6a155448096d2425aa07e81cc6016410091ad0be"
CANDIDATE = "6d4d13735569751a98126052055021a8a04549dd"
GENERATOR = '''package main
import (
 "os"
 "gorm.io/driver/sqlite"
 "gorm.io/gorm"
 "infinite-canvas/backend/internal/database"
)
func main(){
 db,err:=gorm.Open(sqlite.Open(os.Args[1]),&gorm.Config{});if err!=nil{panic(err)}
 if err:=database.MigrateLocalSchema(db);err!=nil{panic(err)}
 pool,err:=db.DB();if err!=nil{panic(err)};if err:=pool.Close();err!=nil{panic(err)}
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--red", action="store_true", help="先在未改候选上复放失败")
    parser.add_argument("--full", action="store_true", help="当前源码运行后台全套")
    args = parser.parse_args()
    repo, output = args.repo.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = repo / ".local/cache"
    cache.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    for key in ("TDS_TEAM_API_KEY", "WEBCAFE_TOKEN", "YUN"):
        env.pop(key, None)
    receipts = []

    def run(name, command, cwd, expected=0):
        meta = {"command": command, "started": datetime.datetime.now(datetime.timezone.utc).isoformat(), "expected_exit": expected}
        with (output / (name + ".txt")).open("wb") as log:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
            meta["pid"] = process.pid
            (output / (name + ".json")).write_text(json.dumps(meta, indent=2) + "\n")
            meta["exit"] = process.wait()
        meta["finished"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        meta["sha256"] = hashlib.sha256((output / (name + ".txt")).read_bytes()).hexdigest()
        (output / (name + ".json")).write_text(json.dumps(meta, indent=2) + "\n")
        receipts.append(meta)
        if meta["exit"] != expected:
            raise SystemExit(f"{name}: exit={meta['exit']}, expected={expected}; 详见输出目录")

    with tempfile.TemporaryDirectory(prefix="step3-replay-", dir=cache) as temporary:
        temporary = Path(temporary)
        snapshots = {}
        for label, commit in (("v26", BASE), ("v27", CANDIDATE)):
            folder = temporary / label
            folder.mkdir()
            archive = subprocess.check_output(["git", "-C", str(repo), "archive", commit, "backend"])
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(folder, filter="data")
            command = folder / "backend/cmd/step3-fixture"
            command.mkdir()
            (command / "main.go").write_text(GENERATOR)
            database = folder / "workspace.db"
            if label == "v27":
                # Reproduce an upgraded candidate database, whose v1 table
                # predates the six new columns; a fresh v27 database has them.
                database.write_bytes((snapshots["v26"] / "workspace.db").read_bytes())
            run("fixture-" + label, ["go", "run", "./cmd/step3-fixture", str(database)], folder / "backend")
            env["REVIEW_" + label.upper() + "_DB"] = str(database)
            snapshots[label] = folder
        if args.red:
            candidate = snapshots["v27"]
            files = {
                "app": ["step3_upgrade_regression_test.go", "step3_upgrade_legacy_retry_test.go", "step3_free_admission_regression_test.go", "step3_free_replay_regression_test.go", "step3_billing_regression_test.go", "step3_background_recovery_test.go", "step3_upscale_recovery_test.go"],
                "handler": ["step3_retry_regression_test.go"],
            }
            hashes = {}
            for package, names in files.items():
                for name in names:
                    relative = Path("backend/internal") / package / name
                    data = (repo / relative).read_bytes()
                    (candidate / relative).write_bytes(data)
                    hashes[str(relative)] = hashlib.sha256(data).hexdigest()
            (output / "red-test-sources.json").write_text(json.dumps({"product_commit": CANDIDATE, "test_sources": hashes}, indent=2) + "\n")
            selected = "^(TestReview|TestStep3(FreeReplay|VideoDTO|BillingProjection|ImageJobTerminal|WorkerRecovers|ClosedResult|AutomaticImageUpscale|ConcurrentRetry))"
            run("fixed-candidate-red", ["go", "test", "./internal/app", "./internal/handler", "-run", selected, "-count=1", "-v"], candidate / "backend", 1)
            if "=== RUN" not in (output / "fixed-candidate-red.txt").read_text():
                raise SystemExit("未运行到测试，不把编译失败计作反例")
        paths = set(subprocess.check_output(["git", "-C", str(repo), "ls-files", "backend", "agent-host/package.json", "agent-host/bun.lock", "plugin-packages"]).decode().splitlines())
        paths.update(subprocess.check_output(["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard", "backend"]).decode().splitlines())
        sources = {path: hashlib.sha256((repo / path).read_bytes()).hexdigest() for path in sorted(paths) if (repo / path).is_file()}
        (output / "tested-source-files.json").write_text(json.dumps(sources, indent=2) + "\n")
        if args.full:
            command = ["go", "test", "./...", "-count=1", "-timeout=25m"]
        else:
            command = ["go", "test", "./internal/app", "./internal/handler", "./internal/repository", "-run", "^(TestReview|TestStep3|TestFreeRetryAdmission)", "-count=1", "-timeout=5m", "-v"]
        run("backend-all" if args.full else "current-targeted", command, repo / "backend")
    print(json.dumps({"checks": len(receipts), "current_exit": receipts[-1]["exit"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
