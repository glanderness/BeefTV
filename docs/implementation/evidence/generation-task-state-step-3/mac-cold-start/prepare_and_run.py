#!/usr/bin/env python3
"""prepare 只准备副本；收到 Chief 采样结束通知后，才可单独调用 execute。"""
import argparse
import datetime
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import time

BASE = "6a155448096d2425aa07e81cc6016410091ad0be"
CANDIDATE = "30ed8d92910fe928b84cf918d870b8d600923144"
RUNTIME = "backend/internal/bootstrap/runtime.go"
TEST_FILE = "backend/internal/bootstrap/local_runtime_budget_test.go"
TEST = "TestDesktopColdOpenBudgetAndNoIdleOutbound"
PHASES = ("database_and_schema", "service_and_plugins", "builtin_initializers", "composition_and_routes")
ORDER = ("base", "candidate", "candidate", "base")
EXTERNAL = Path("/Volumes/ExternalWork")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def files(folder):
    return {str(p.relative_to(folder)): sha(p.read_bytes()) for p in sorted(folder.rglob("*")) if p.is_file()}


def instrument(source):
    replacements = (
        ("func Open(_ context.Context, raw Config) (result *Runtime, openErr error) {\n", """func Open(_ context.Context, raw Config) (result *Runtime, openErr error) {
	step3PhaseStarted := time.Now()
	step3MarkPhase := func(name string) {
		fmt.Fprintf(os.Stderr, "STEP3_COLD_PHASE %s %d\\n", name, time.Since(step3PhaseStarted).Nanoseconds())
		step3PhaseStarted = time.Now()
	}
"""),
        ("\trepo := repository.New(db)\n", '\tstep3MarkPhase("database_and_schema")\n\trepo := repository.New(db)\n'),
        ("\tsvc := app.NewLocal(repo, cfg.DataDir)\n", '\tsvc := app.NewLocal(repo, cfg.DataDir)\n\tstep3MarkPhase("service_and_plugins")\n'),
        ("\tproviderConfig, configErr := workspace.NewProviderConfig(cfg.DataDir)\n", '\tstep3MarkPhase("builtin_initializers")\n\tdefer step3MarkPhase("composition_and_routes")\n\tproviderConfig, configErr := workspace.NewProviderConfig(cfg.DataDir)\n'),
    )
    for before, after in replacements:
        if source.count(before) != 1:
            raise SystemExit("固定源码锚点不匹配，停止准备，不猜测插桩位置")
        source = source.replace(before, after, 1)
    return source


def prepare(repo, work):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args])

    base_test = git("show", BASE + ":" + TEST_FILE)
    base_runtime = git("show", BASE + ":" + RUNTIME)
    assert base_test == git("show", CANDIDATE + ":" + TEST_FILE)
    assert base_runtime == git("show", CANDIDATE + ":" + RUNTIME)
    for lock in ("backend/go.mod", "backend/go.sum"):
        assert git("show", BASE + ":" + lock) == git("show", CANDIDATE + ":" + lock)
    work.mkdir(parents=True, exist_ok=False)
    (work / "data").mkdir()
    (work / "results").mkdir()
    (work / "results/.gitattributes").write_text("*.txt -text -eol\n")
    variants = {}
    for label, commit in (("base", BASE), ("candidate", CANDIDATE)):
        original = work / (label + "-original")
        original.mkdir()
        archive = git("archive", commit, "backend")
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(original, filter="data")
        diagnostic = work / (label + "-diagnostic")
        shutil.copytree(original, diagnostic)
        old = (original / RUNTIME).read_text()
        new = instrument(old)
        (diagnostic / RUNTIME).write_text(new)
        diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile="a/" + RUNTIME, tofile="b/" + RUNTIME))
        (work / (label + "-diagnostic.patch")).write_text(diff)
        for flavor, folder in (("original", original), ("diagnostic", diagnostic)):
            assert (folder / TEST_FILE).read_bytes() == base_test
            variants[label + "-" + flavor] = {"product_commit": commit, "source_hashes": files(folder)}
    write_json(work / "prepared.json", {
        "status": "prepared_only_not_compiled_or_run", "base": BASE, "candidate": CANDIDATE,
        "runtime_sha256": sha(base_runtime), "original_test_sha256": sha(base_test),
        "budget_seconds": 5, "idle_outbound_required": 0,
        "order_per_flavor": ORDER, "phases": PHASES, "variants": variants,
    })
    print("只完成源码与诊断副本准备；未调用 Go。协议包在 execute 时冻结，需先收到 Chief 窗口通知。", flush=True)


def execute(work, plugins):
    if platform.system() != "Darwin":
        raise SystemExit("本材料用于 Mac 对照；其他平台的结果不能替代 Mac")
    prepared = json.loads((work / "prepared.json").read_text())
    for name, info in prepared["variants"].items():
        if files(work / name) != info["source_hashes"]:
            raise SystemExit("准备后的源码有变化，重新准备独立目录，不在旧结果上重跑")
    # 两侧只读同一份冻结协议包，不改原目录，也不在测量中生成协议包。
    packages = sorted(plugins.glob("*.beeftv-plugin"))
    if not packages:
        raise SystemExit("缺少已物化协议包，停止；不把环境失败当作冷启动回归")
    frozen = work / "official-plugins"
    frozen.mkdir()
    for package in packages:
        shutil.copyfile(package, frozen / package.name)
    plugin_hashes = files(frozen)
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(("CANVAS_", "BEEFTV_")) or key in ("TDS_TEAM_API_KEY", "WEBCAFE_TOKEN", "YUN"):
            env.pop(key, None)
    env["CANVAS_OFFICIAL_PLUGIN_DIR"] = str(frozen)
    env["TMPDIR"] = str(work / "data")
    results = work / "results"
    # 负载快照在用例进程之外采集，不计入 Open，也不主动制造负载。
    def snapshot(name):
        observations = []
        for suffix, command in (
            ("uptime", ["uptime"]),
            ("processes", ["ps", "-Ao", "pid,ppid,pcpu,pmem,comm"]),
            ("memory", ["vm_stat"]),
            ("disk", ["iostat", "-d", "-c", "1"]),
        ):
            path = results / (name + "-" + suffix + ".txt")
            started = datetime.datetime.now(datetime.timezone.utc).isoformat()
            with path.open("xb") as log:
                observed = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
            observations.append({"command": command, "started": started,
                                 "finished": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                 "exit": observed.returncode, "raw_output": path.name,
                                 "sha256": sha(path.read_bytes())})
        return observations

    write_json(results / "environment.json", {
        "platform": platform.platform(), "cpu_count": os.cpu_count(),
        "go_version": subprocess.check_output(["go", "version"], cwd=work / "base-original/backend", env=env).decode().strip(),
        "base": BASE, "candidate": CANDIDATE, "plugins_sha256": plugin_hashes,
        "tmpdir": str(work / "data"), "flavor_order": ("original", "diagnostic"),
        "order_per_flavor": ORDER,
        "go_environment": {k: env.get(k) for k in ("GOMAXPROCS", "GODEBUG", "CGO_ENABLED", "GOTOOLCHAIN", "GOFLAGS", "GOCACHE", "GOMODCACHE")},
        "effective_go_environment": json.loads(subprocess.check_output([
            "go", "env", "-json", "GOOS", "GOARCH", "GOVERSION", "CGO_ENABLED",
            "GOTOOLCHAIN", "GOFLAGS", "GOCACHE", "GOMODCACHE", "CC",
        ], cwd=work / "base-original/backend", env=env)),
        "system": subprocess.check_output(["sw_vers"], env=env).decode(),
        "hardware": subprocess.check_output([
            "sysctl", "hw.ncpu", "hw.memsize", "machdep.cpu.brand_string",
        ], env=env).decode(),
        "prepared_sha256": sha((work / "prepared.json").read_bytes()),
    })

    def run(name, command, cwd):
        before = snapshot(name + "-before")
        meta = {"command": command, "cwd": str(cwd), "started": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        meta["load_before"] = before
        started_ns = time.monotonic_ns()
        with (results / (name + ".txt")).open("xb") as log:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
            meta["pid"] = process.pid
            write_json(results / (name + ".json"), meta)
            print("运行 " + name + "，PID=" + str(process.pid), flush=True)
            meta["exit"] = process.wait()
        raw = (results / (name + ".txt")).read_bytes()
        meta.update(finished=datetime.datetime.now(datetime.timezone.utc).isoformat(), sha256=sha(raw),
                    elapsed_ns=time.monotonic_ns() - started_ns)
        if name.startswith("build-") and meta["exit"] == 0:
            meta["binary_sha256"] = sha(Path(command[command.index("-o") + 1]).read_bytes())
        meta["load_after"] = snapshot(name + "-after")
        write_json(results / (name + ".json"), meta)
        return meta, raw.decode(errors="replace")

    # 编译全部在计时采样之前完成；串行编译，不启动全套或客户端。
    for name in prepared["variants"]:
        meta, _ = run("build-" + name, ["go", "test", "-mod=readonly", "-c", "-o", str(work / (name + ".test")), "./internal/bootstrap"], work / name / "backend")
        if meta["exit"] != 0:
            raise SystemExit("预编译失败，保留原始输出，未开始采样")
    rows = []
    for flavor in ("original", "diagnostic"):
        for index, label in enumerate(ORDER, 1):
            name = label + "-" + flavor
            meta, output = run(f"{flavor}-{index}-{label}", [str(work / (name + ".test")), "-test.run=^" + TEST + "$", "-test.count=1", "-test.timeout=2m", "-test.v"], work / name / "backend")
            opened = re.search(r"local_open_ms=(\d+) idle_outbound_requests=0", output)
            phase_rows = re.findall(r"STEP3_COLD_PHASE (\w+) (\d+)", output)
            phases_valid = [p[0] for p in phase_rows] == list(PHASES) if flavor == "diagnostic" else not phase_rows
            observed_runs = re.findall(r"^=== RUN\s+(\S+)$", output, re.MULTILINE)
            observed_passes = re.findall(r"^--- PASS: (\S+) \(", output, re.MULTILINE)
            valid_pass = meta["exit"] == 0 and observed_runs == [TEST] and observed_passes == [TEST] and opened is not None and phases_valid
            rows.append({"variant": name, "position": index, "exit": meta["exit"], "valid_pass": valid_pass, "observed_tests": observed_runs, "observed_passes": observed_passes, "local_open_ms": int(opened[1]) if opened else None, "phase_ns": {k: int(v) for k, v in phase_rows}, "raw_output": f"{flavor}-{index}-{label}.txt"})
    unchanged = plugin_hashes == files(frozen) and all(files(work / n) == info["source_hashes"] for n, info in prepared["variants"].items())
    write_json(results / "summary.json", {"runs": rows, "inputs_unchanged": unchanged, "prior_parallel_failure_root_cause": "仍需根据数据判断，单项通过不消除原全套失败", "diagnostic_is_acceptance": False})
    if not unchanged or not all(row["valid_pass"] for row in rows):
        raise SystemExit("存在失败或缺少必要观测，见原始输出；不自动重跑或放宽阈值")
    print("八次单项均结束；诊断结果另列，不代表原并行全套问题已解决。", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "execute"))
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--repo", type=Path, help="prepare 使用；含两个固定 Git 对象")
    parser.add_argument("--plugins", type=Path, help="execute 使用；已物化的协议包目录")
    args = parser.parse_args()
    work = args.workdir.resolve()
    if not EXTERNAL.is_mount() or not work.is_relative_to(EXTERNAL):
        raise SystemExit("需要已挂载的 ExternalWork 目录，不创建系统盘回退")
    if args.stage == "prepare":
        if args.repo is None:
            parser.error("prepare 需要 --repo")
        prepare(args.repo.resolve(), work)
    else:
        if args.plugins is None:
            parser.error("execute 需要 --plugins；仅在 Chief 明确通知窗口后使用")
        execute(work, args.plugins.resolve())


if __name__ == "__main__":
    main()
