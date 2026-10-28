#!/usr/bin/env python3
"""prepare 不调用 Go；execute 仅供 Chief 明确释放采样窗口后的一个前台回合。"""
import argparse
import ast
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
import sys
import tarfile
import time

OLD = "850d89c109b7e94a356834ee51eedba6dba019fb"
CANDIDATE = "30ed8d92910fe928b84cf918d870b8d600923144"
BASE = "6a155448096d2425aa07e81cc6016410091ad0be"
V27 = "6d4d13735569751a98126052055021a8a04549dd"
RUNTIME = "backend/internal/bootstrap/runtime.go"
TEST = "TestDesktopColdOpenBudgetAndNoIdleOutbound"
TEST_SOURCE = "backend/internal/bootstrap/local_runtime_budget_test.go"
REPLAY = "docs/implementation/evidence/generation-task-state-step-3/revision/replay.py"
PHASES = ("database_and_schema", "service_and_plugins", "builtin_initializers", "composition_and_routes")
# 这两项是 30ed 新增的 N1 用例，旧并行套件不含它们，不在本次重跑。
SKIP_NEW_N1 = "^(TestStep3ImageRefundRetryAfterResultConclusion|TestStep3ImageConclusionWithoutRefundDoesNotRequeue)$"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def instrument(source):
    opening = "func Open(_ context.Context, raw Config) (result *Runtime, openErr error) {\n"
    inserted = opening + '''
	step3TraceContext, step3TraceTask := trace.NewTask(context.Background(), "STEP3_OPEN")
	trace.Log(step3TraceContext, "data_dir", raw.DataDir)
	defer step3TraceTask.End()
	step3PhaseNames := []string{"database_and_schema", "service_and_plugins", "builtin_initializers", "composition_and_routes"}
	step3PhaseIndex := 0
	step3Region := trace.StartRegion(step3TraceContext, step3PhaseNames[0])
	defer func() {
		if step3Region != nil {
			step3Region.End()
		}
	}()
	step3PhaseStarted := time.Now()
	step3MarkPhase := func(name string) {
		elapsed := time.Since(step3PhaseStarted)
		step3Region.End()
		step3Region = nil
		fmt.Fprintf(os.Stderr, "STEP3_COLD_PHASE %s %d\\n", name, elapsed.Nanoseconds())
		trace.Logf(step3TraceContext, "STEP3_COLD_PHASE", "%s %d", name, elapsed.Nanoseconds())
		step3PhaseIndex++
		if step3PhaseIndex < len(step3PhaseNames) {
			step3Region = trace.StartRegion(step3TraceContext, step3PhaseNames[step3PhaseIndex])
		}
		step3PhaseStarted = time.Now()
	}
'''
    for before, after in (
        ('\t"os"\n', '\t"os"\n\t"runtime/trace"\n'),
        (opening, inserted),
        ("\trepo := repository.New(db)\n", '\tstep3MarkPhase("database_and_schema")\n\trepo := repository.New(db)\n'),
        ("\tsvc := app.NewLocal(repo, cfg.DataDir)\n", '\tsvc := app.NewLocal(repo, cfg.DataDir)\n\tstep3MarkPhase("service_and_plugins")\n'),
        ("\tproviderConfig, configErr := workspace.NewProviderConfig(cfg.DataDir)\n", '\tstep3MarkPhase("builtin_initializers")\n\tdefer step3MarkPhase("composition_and_routes")\n\tproviderConfig, configErr := workspace.NewProviderConfig(cfg.DataDir)\n'),
    ):
        if source.count(before) != 1:
            raise SystemExit("固定源码锚点不匹配，不猜测插桩位置")
        source = source.replace(before, after, 1)
    return source


def prepare(args):
    repo, work, plugins = args.repo.resolve(), args.workdir.resolve(), args.plugins.resolve()
    for path in (RUNTIME, TEST_SOURCE, "backend/go.mod", "backend/go.sum"):
        assert git(repo, "show", OLD + ":" + path) == git(repo, "show", CANDIDATE + ":" + path)
    assert args.host_deps.is_dir() and args.gomodcache.is_dir()
    for name in ("package.json", "bun.lock"):
        assert (args.host_deps.parent / name).read_bytes() == git(repo, "show", CANDIDATE + ":agent-host/" + name)
    packages = {p.name: sha(p.read_bytes()) for p in sorted(plugins.glob("*.beeftv-plugin"))}
    assert len(packages) == 86, "现有物化协议包数量变化，先核来源"
    go = Path(shutil.which("go")).resolve()  # 只定位文件，不运行工具链。
    work.mkdir(parents=True, exist_ok=False)
    old = git(repo, "show", CANDIDATE + ":" + RUNTIME).decode()
    new = instrument(old)
    (work / "diagnostic-runtime.go").write_text(new)
    (work / "open-phases-trace.patch").write_text("".join(difflib.unified_diff(
        old.splitlines(True), new.splitlines(True), fromfile="a/" + RUNTIME, tofile="b/" + RUNTIME)))
    generator = next(ast.literal_eval(node.value) for node in ast.parse(git(repo, "show", OLD + ":" + REPLAY)).body
                     if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "GENERATOR" for t in node.targets))
    (work / "fixture-main.go").write_text(generator)
    plan = {
        "status": "prepared_only_no_go_or_client", "prepared_at": now(), "repo": str(repo),
        "candidate": CANDIDATE, "old_failure_candidate": OLD,
        "candidate_backend_tree": git(repo, "rev-parse", CANDIDATE + ":backend").decode().strip(),
        "runtime_sha256": sha(old.encode()), "diagnostic_runtime_sha256": sha(new.encode()),
        "original_test_sha256": sha(git(repo, "show", CANDIDATE + ":" + TEST_SOURCE)),
        "generator_sha256": sha(generator.encode()), "runner_sha256": sha(Path(__file__).read_bytes()),
        "go_executable": str(go), "go_executable_sha256": sha(go.read_bytes()),
        "plugins": str(plugins), "plugin_hashes": packages,
        "host_deps": str(args.host_deps.resolve()), "gomodcache": str(args.gomodcache.resolve()),
        "original_command": ["go", "test", "./...", "-count=1", "-timeout=25m"],
        "extra_flags": ["-mod=readonly", "-json", "-exec=<本脚本 _exec>"],
        "bootstrap_extra_flags": ["-test.trace=<results/bootstrap.trace>"],
        "app_skip_new_N1": SKIP_NEW_N1, "explicit_p": None, "explicit_parallel": None,
        "test_budget_seconds": 5, "idle_outbound_required": 0,
        "fixture_commands_before_capture": ["go run ./cmd/step3-fixture <v26.db>", "go run ./cmd/step3-fixture <v27.db>"],
        "capture_invocations": 1, "separate_cold_runs": 0,
    }
    write_json(work / "prepared.json", plan)
    print("只完成固定输入、四阶段trace诊断源码和命令准备；未调用Go、未启动客户端。")


def extract(repo, commit, folder, *paths):
    folder.mkdir()
    with tarfile.open(fileobj=io.BytesIO(git(repo, "archive", commit, *paths))) as archive:
        archive.extractall(folder, filter="data")


def execute(args):
    if platform.system() != "Darwin" or not args.window_released:
        raise SystemExit("仅在Mac且Chief明确释放本轮采样窗口后执行；不在工具内等待")
    work = args.workdir.resolve()
    plan = json.loads((work / "prepared.json").read_text())
    repo = Path(plan["repo"])
    assert sha(Path(__file__).read_bytes()) == plan["runner_sha256"]
    assert sha(Path(plan["go_executable"]).read_bytes()) == plan["go_executable_sha256"]
    assert sha((work / "diagnostic-runtime.go").read_bytes()) == plan["diagnostic_runtime_sha256"]
    assert sha((work / "fixture-main.go").read_bytes()) == plan["generator_sha256"]
    with (work / "execute-once.json").open("x") as receipt:
        json.dump({"started": now(), "window_release": args.window_released}, receipt, ensure_ascii=False)
    results = work / "results"
    results.mkdir()
    (results / ".gitattributes").write_text("*.txt -text -eol\n*.jsonl -text -eol\n*.trace binary\n")
    for name in ("data", "go-tmp", "home", "official-plugins"):
        (work / name).mkdir()
    for name, expected in plan["plugin_hashes"].items():
        raw = (Path(plan["plugins"]) / name).read_bytes()
        assert sha(raw) == expected
        (work / "official-plugins" / name).write_bytes(raw)
    source = work / "source"
    extract(repo, CANDIDATE, source)
    (source / RUNTIME).write_bytes((work / "diagnostic-runtime.go").read_bytes())
    assert sha((source / TEST_SOURCE).read_bytes()) == plan["original_test_sha256"]
    # 依赖只复制到本任务副本；不安装、不改共享 node_modules。
    shutil.copytree(plan["host_deps"], source / "agent-host/node_modules", symlinks=True)
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TZ", "DEVELOPER_DIR", "SDKROOT") if k in os.environ}
    env.update(HOME=str(work / "home"), TMPDIR=str(work / "data"), GOTMPDIR=str(work / "go-tmp"),
               GOCACHE=str(work / "go-build-cache"), GOMODCACHE=plan["gomodcache"], GOPROXY="off", GOSUMDB="off",
               GOENV="off", GOTOOLCHAIN="local", CANVAS_OFFICIAL_PLUGIN_DIR=str(work / "official-plugins"))
    go = plan["go_executable"]

    def run(name, command, cwd):
        meta = {"command": command, "cwd": str(cwd), "started": now()}
        with (results / (name + ".txt")).open("xb") as log:
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            meta["pid"] = proc.pid
            write_json(results / (name + ".json"), meta)
            print(name + " PID=" + str(proc.pid), flush=True)
            try:
                meta["exit"] = proc.wait()
            except BaseException:
                import signal
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                proc.wait()
                raise
        meta.update(finished=now(), sha256=sha((results / (name + ".txt")).read_bytes()))
        write_json(results / (name + ".json"), meta)
        return meta

    # 与原 replay.py 相同的两份历史库，仅为恢复旧套件输入，不另跑升级断言。
    for label, commit in (("v26", BASE), ("v27", V27)):
        folder = work / ("fixture-" + label)
        extract(repo, commit, folder, "backend")
        main = folder / "backend/cmd/step3-fixture"
        main.mkdir()
        (main / "main.go").write_bytes((work / "fixture-main.go").read_bytes())
        database = work / (label + ".db")
        if label == "v27":
            shutil.copyfile(work / "v26.db", database)
        if run("fixture-" + label, [go, "run", "./cmd/step3-fixture", str(database)], folder / "backend")["exit"]:
            raise SystemExit("历史夹具准备失败，未执行并行捕获；不自动重跑")
        env["REVIEW_" + label.upper() + "_DB"] = str(database)
    for name, command in (("go-version", [go, "version"]), ("go-env", [go, "env", "-json", "GOOS", "GOARCH", "GOVERSION", "GOFLAGS", "GOTOOLCHAIN", "GOMODCACHE", "GOCACHE"])):
        if run(name, command, source / "backend")["exit"]:
            raise SystemExit("工具链观测失败，停止；不自动重跑")
    # -exec 字符串由Go分词，不经shell；使用当前固定、不含空白的路径。
    parts = [sys.executable, str(Path(__file__).resolve()), "_exec", str(work)]
    assert all(not any(c.isspace() for c in part) for part in parts)
    command = [go, "test", "./...", "-count=1", "-timeout=25m", "-mod=readonly", "-json", "-exec=" + " ".join(parts)]
    for name in ("before", "after"):
        if name == "after":
            capture = run("parallel-suite", command, source / "backend")
        for suffix, cmd in (("load", ["uptime"]), ("processes", ["ps", "-Ao", "pid,ppid,pcpu,pmem,comm"]), ("memory", ["vm_stat"]), ("disk", ["iostat", "-d", "-c", "1"])):
            run(name + "-" + suffix, cmd, source / "backend")
    events = []
    for line in (results / "parallel-suite.txt").read_bytes().splitlines():
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if row.get("Action") in ("start", "pass", "fail", "skip"):
            events.append(row)
    write_json(results / "package-test-events.json", events)
    trace = results / "bootstrap.trace"
    write_json(results / "capture-status.json", {
        "finished": now(), "suite_exit": capture["exit"], "capture_invocations": 1,
        "trace_bytes": trace.stat().st_size if trace.exists() else None,
        "trace_sha256": sha(trace.read_bytes()) if trace.exists() else None,
        "interpretation": "须逐名核冷启动及Open regions；单次通过或无trace均不能解释旧失败，不自动追加测试",
        "diagnostic_is_acceptance": False,
    })
    print("一次并行命令已结束；立即向Chief报告实际退出与进程情况，不再追加尝试。", flush=True)
    return capture["exit"]


def exec_test(work, arguments):
    """由唯一一次 go test -exec 回调，不单独运行任何测试。"""
    if not (work / "execute-once.json").is_file():
        raise SystemExit("_exec只能由已释放窗口后的单次并行命令调用")
    results = work / "results"
    binary = Path(arguments[0])
    record = {"binary": str(binary), "arguments": arguments[1:], "started": now(), "wrapper_pid": os.getpid()}
    record_path = results / ("exec-" + str(os.getpid()) + ".json")
    if binary.name != "bootstrap.test":
        if binary.name == "app.test":
            arguments += ["-test.skip=" + SKIP_NEW_N1]
        record["executed_arguments"] = arguments
        write_json(record_path, record)
        os.execv(str(binary), arguments)
    # 原字节另存；只bootstrap附加trace，不让其他包争写同一trace文件。
    with (results / "bootstrap-claimed.json").open("x") as marker:
        json.dump({"wrapper_pid": os.getpid(), "started": now()}, marker)
    # -json 已由Go设置test2json详细输出，保留其原有控制标记。
    arguments += ["-test.trace=" + str(results / "bootstrap.trace")]
    record["executed_arguments"] = arguments
    write_json(record_path, record)
    started_ns = time.monotonic_ns()
    with (results / "bootstrap-raw.txt").open("xb") as raw:
        proc = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        record["pid"] = proc.pid
        write_json(record_path, record)
        while chunk := proc.stdout.read1(65536):
            raw.write(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        record["exit"] = proc.wait()
    record.update(finished=now(), elapsed_ns=time.monotonic_ns() - started_ns,
                  raw_sha256=sha((results / "bootstrap-raw.txt").read_bytes()))
    write_json(record_path, record)
    return record["exit"]


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "_exec":
        return exec_test(Path(sys.argv[2]), sys.argv[3:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "execute"))
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--plugins", type=Path)
    parser.add_argument("--host-deps", type=Path)
    parser.add_argument("--gomodcache", type=Path)
    parser.add_argument("--window-released", help="Chief明确释放本轮窗口的通知原文/时间；不能填推测")
    args = parser.parse_args()
    if not Path("/Volumes/ExternalWork").is_mount() or not args.workdir.resolve().is_relative_to("/Volumes/ExternalWork"):
        parser.error("只使用已挂载ExternalWork，不回退到系统盘")
    if args.stage == "prepare":
        if any(getattr(args, key) is None for key in ("repo", "plugins", "host_deps", "gomodcache")):
            parser.error("prepare需要固定仓库、现有协议包、宿主依赖和Go模块缓存")
        prepare(args)
        return 0
    return execute(args)


if __name__ == "__main__":
    raise SystemExit(main())
