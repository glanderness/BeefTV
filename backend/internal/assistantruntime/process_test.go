package assistantruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/localipc"
)

const fixtureEnv = "BEEFTV_ASSISTANT_RUNTIME_FIXTURE"

var platformProcessFixtures = map[string]func() int{}

func TestMain(m *testing.M) {
	if mode := strings.TrimSpace(os.Getenv(fixtureEnv)); mode != "" {
		os.Exit(runProcessFixture(mode))
	}
	os.Exit(m.Run())
}

func runProcessFixture(mode string) int {
	switch mode {
	case "sleep":
		waitForStopSignal()
		return 0
	case "ignore-sigterm-sleep":
		signal.Ignore(syscall.SIGTERM)
		time.Sleep(30 * time.Second)
		return 0
	case "exit0":
		return 0
	case "crash":
		return 2
	case "fail-listen":
		return 2
	case "http":
		return runHTTPFixture()
	case "supervisor":
		return runSupervisorFixture()
	default:
		if run := platformProcessFixtures[mode]; run != nil {
			return run()
		}
		fmt.Fprintf(os.Stderr, "unknown fixture %q\n", mode)
		return 1
	}
}

func runHTTPFixture() int {
	nonce := os.Getenv("BEEFTV_AGENT_INSTANCE_NONCE")
	if dataDir := os.Getenv("BEEFTV_AGENT_DATA_DIR"); dataDir != "" {
		_ = os.WriteFile(filepath.Join(dataDir, "child-env.txt"), []byte(strings.Join(os.Environ(), "\n")), 0o600)
		_ = os.WriteFile(filepath.Join(dataDir, "child-pid.txt"), []byte(strconv.Itoa(os.Getpid())), 0o600)
		if f, err := os.OpenFile(filepath.Join(dataDir, "child-launches.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
			_ = f.Close()
		}
	}
	go func() {
		buf := make([]byte, 1)
		for {
			if _, err := os.Stdin.Read(buf); err != nil {
				fmt.Fprintf(os.Stderr, "fixture lifetime stdin ended: %v\n", err)
				os.Exit(0)
			}
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if nonce != "" && r.Header.Get(InstanceHeader) != nonce {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"instance_mismatch"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		busy := os.Getenv("BEEFTV_AGENT_BUSY") == "1" || os.Getenv("BEEFTV_ASSISTANT_RUNTIME_BUSY") == "1"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "busy": busy, "model": os.Getenv("BEEFTV_AGENT_MODEL"),
			"instance": InstanceProof(nonce),
		})
	})
	if fdRaw := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_LISTEN_FD")); fdRaw != "" {
		fd, err := strconv.Atoi(fdRaw)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		listener, err := net.FileListener(os.NewFile(uintptr(fd), "listen"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if err := http.Serve(listener, mux); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	if pipe := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PIPE")); pipe != "" {
		listener, err := localipc.Listen(pipe)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if err := http.Serve(listener, mux); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}
	port := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_PORT"))
	if port == "" {
		fmt.Fprintln(os.Stderr, "missing BEEFTV_AGENT_PORT")
		return 2
	}
	fmt.Fprintln(os.Stderr, "fixture listening on allocated loopback port")
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func runSupervisorFixture() int {
	dataDir := os.Getenv("BEEFTV_SUPERVISOR_DATA")
	config := HostConfig{HostCommand: os.Args[0], HostArgs: []string{}}
	encoded, err := json.Marshal(config)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), encoded, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	host := New(Options{
		DataDir:      dataDir,
		ReadyTimeout: 8 * time.Second,
		Environ: func() []string {
			out := make([]string, 0)
			for _, entry := range os.Environ() {
				if strings.HasPrefix(entry, fixtureEnv+"=") {
					continue
				}
				out = append(out, entry)
			}
			return append(out, fixtureEnv+"=http")
		},
	})
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = os.WriteFile(filepath.Join(dataDir, "child-pid.txt"), []byte(strconv.Itoa(host.PID())), 0o600)
	// Publish readiness last; readers must never observe the PID file mid-truncate.
	_ = os.WriteFile(filepath.Join(dataDir, "endpoint.txt"), []byte(host.Endpoint()), 0o600)
	select {}
}

func fixtureProvider() assistant.Provider {
	return assistant.Provider{Model: "m", BaseURL: "https://example.invalid/v1", APIKey: "k", Protocol: "chat-completion"}
}

func waitForStopSignal() {
	notified := make(chan os.Signal, 1)
	signal.Notify(notified, os.Interrupt, syscall.SIGTERM)
	<-notified
}

func fixtureHost(t *testing.T, mode string) *Host {
	t.Helper()
	dataDir := t.TempDir()
	config := HostConfig{HostCommand: os.Args[0], HostArgs: []string{}}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, hostConfigFile), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dataDir,
		ReadyTimeout: 8 * time.Second,
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"="+mode)
		},
	})
	t.Cleanup(func() { _ = host.Stop() })
	return host
}

func waitUntil(timeout time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ok()
}

func TestHostStopReapsOwnChild(t *testing.T) {
	host := fixtureHost(t, "http")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	if host.PID() == 0 || !host.Running() {
		t.Fatal("子进程应处于运行状态")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := host.StopContext(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本 Host 启动的宿主: %v", err)
	}
	if host.Running() {
		t.Fatal("停止后不应仍报告运行中")
	}
	if err := host.StopContext(context.Background()); err != nil {
		t.Fatalf("无自有宿主时钩子应为 no-op，实际 %v", err)
	}
	if launched, err := host.Ensure(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token", true); err == nil || launched || host.Running() {
		t.Fatalf("应用退出期间的状态查询不得重启宿主：launched=%v err=%v", launched, err)
	}
}

func TestHostRestartReplacesChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	if first == 0 {
		t.Fatal("未记录子进程 PID")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("重启失败: %v", err)
	}
	if !host.Running() {
		t.Fatal("重启后应有新的子进程")
	}
	second := host.PID()
	if second == 0 || second == first {
		t.Fatalf("重启应换新 PID，first=%d second=%d", first, second)
	}
}

func TestHostCrashIsReapedAndCanRelaunch(t *testing.T) {
	host := fixtureHost(t, "crash")
	provider := fixtureProvider()
	for attempt := 0; attempt < 2; attempt++ {
		if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err == nil {
			t.Fatal("崩溃子进程不得被报告为已就绪")
		}
		if host.Running() || host.Endpoint() != "" {
			t.Fatal("崩溃子进程应被回收且不得留下可复用端点")
		}
	}
}

func TestSeparateHostsDoNotShareProcessOwnership(t *testing.T) {
	first := fixtureHost(t, "http")
	second := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := first.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if err := second.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	firstPID, secondPID := first.PID(), second.PID()
	if firstPID == 0 || secondPID == 0 || firstPID == secondPID {
		t.Fatalf("两个 Host 应各自持有子进程 first=%d second=%d", firstPID, secondPID)
	}
	if err := first.Stop(); err != nil {
		t.Fatal(err)
	}
	if first.Running() {
		t.Fatal("停止 first 后其自身不应仍在运行")
	}
	if !second.Running() || second.PID() != secondPID {
		t.Fatal("停止 first 不得带走 second 的子进程")
	}
}

func TestEnsureRestartsWhenFingerprintChangesAndIdle(t *testing.T) {
	host := fixtureHost(t, "http")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.APIKey = "rotated"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !launched {
		t.Fatal("空闲且指纹变化时应重启")
	}
	if host.PID() == first {
		t.Fatal("指纹变化重启应换新 PID")
	}
	launched, err = host.Ensure(updated, "http://127.0.0.1:18090/api", "", true)
	if err != nil || launched {
		t.Fatalf("相同指纹且在跑时 Ensure 应为 no-op launched=%v err=%v", launched, err)
	}
}

func TestConcurrentLifecycleLeavesSingleOwnedChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	updated := provider
	updated.APIKey = "rotated"
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			_, _ = host.Ensure(provider, "http://127.0.0.1:18090/api", "", true)
		}()
		go func() {
			defer wg.Done()
			_, _ = host.Ensure(updated, "http://127.0.0.1:18090/api", "", false)
		}()
		go func() {
			defer wg.Done()
			_ = host.Restart(provider, "http://127.0.0.1:18090/api", "")
		}()
	}
	wg.Wait()
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
	if host.Running() {
		t.Fatal("并发 Ensure/Restart 结束后 Stop 必须带走本 Host 的子进程")
	}
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("单次 Wait 约束在并发后仍应可再次启动: %v", err)
	}
	if !host.Running() {
		t.Fatal("再次启动应有子进程")
	}
}

func TestEnsureDoesNotRestartBusyHostOnFingerprintChange(t *testing.T) {
	host := fixtureHost(t, "http")
	original := fixtureProvider()
	if err := host.Launch(original, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	first := host.PID()
	updated := original
	updated.Model = "other"
	launched, err := host.Ensure(updated, "http://127.0.0.1:18090/api", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if launched {
		t.Fatal("非空闲时不得因指纹变化重启")
	}
	if host.PID() != first {
		t.Fatal("非空闲时 PID 应保持不变")
	}
}

func startOutsider(t *testing.T) *exec.Cmd {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "120", "127.0.0.1")
	} else {
		cmd = exec.Command("sleep", "120")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}

func startForeignHealth(t *testing.T) (addr string, hits *int32) {
	t.Helper()
	var n int32
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"busy":false,"model":"foreign","instance":"not-ours"}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return "http://" + listener.Addr().String(), &n
}

func TestFreshHostDoesNotAdoptForeignHealthyListener(t *testing.T) {
	foreign, hits := startForeignHealth(t)
	t.Setenv("BEEFTV_AGENT_HOST_URL", foreign)
	t.Setenv("BEEFTV_AGENT_PORT", "18500")
	host := New(Options{DataDir: t.TempDir()})
	if host.Endpoint() != "" || host.Running() {
		t.Fatal("新构造的 Host 不得认领已有监听器")
	}
	health := host.Probe(context.Background())
	if health.OK {
		t.Fatal("Probe 不得把外部 /health 当成自有子进程")
	}
	if err := host.Stop(); err != nil {
		t.Fatal(err)
	}
	if *hits != 0 {
		t.Fatalf("Stop/Probe 不得打到外部监听器，hits=%d", *hits)
	}
	req, err := http.NewRequest(http.MethodGet, foreign+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatal("外部监听器必须仍在运行")
	}
}

func TestLaunchPinsPortAndDropsSpoofedOwnerOpenAI(t *testing.T) {
	host := fixtureHost(t, "http")
	host.opts.Environ = func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + os.Getenv("HOME"),
			fixtureEnv + "=http",
			"BEEFTV_AGENT_PORT=18500",
			"BEEFTV_OWNER_TOKEN=stolen-owner",
			"BEEFTV_AGENT_HOST_TOKEN=stolen-host",
			"OPENAI_API_KEY=sk-openai",
			"ANTHROPIC_API_KEY=sk-ant",
		}
	}
	host.opts.HostToken = func() string { return "pinned-host" }
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(host.dataDir(), "child-env.txt"))
	if err != nil {
		t.Fatal(err)
	}
	childEnv := strings.Split(string(raw), "\n")
	if pipe := envValue(childEnv, "BEEFTV_AGENT_PIPE"); pipe != "" {
		if port := envValue(childEnv, "BEEFTV_AGENT_PORT"); port != "" {
			t.Fatalf("管道模式下不得保留或分配 TCP 端口，得到 %q", port)
		}
	} else if port := envValue(childEnv, "BEEFTV_AGENT_PORT"); port == "" || port == "18500" {
		t.Fatalf("子进程 PORT 必须是监督器钉死的实例端口，得到 %q", port)
	}
	if envValue(childEnv, "BEEFTV_OWNER_TOKEN") != "" {
		t.Fatal("子进程不得看到 OWNER_TOKEN")
	}
	if envValue(childEnv, "BEEFTV_AGENT_HOST_TOKEN") != "pinned-host" {
		t.Fatalf("子进程宿主凭据应被覆盖，得到 %q", envValue(childEnv, "BEEFTV_AGENT_HOST_TOKEN"))
	}
	if envHasKey(childEnv, "OPENAI_API_KEY") || envHasKey(childEnv, "ANTHROPIC_API_KEY") {
		t.Fatal("子进程不得继承 OPENAI/ANTHROPIC 密钥")
	}
	if host.Endpoint() == "http://127.0.0.1:18500" {
		t.Fatal("端点不得落在继承的 18500")
	}
}

func TestRestartFailureDoesNotReportSuccessOrKeepEndpoint(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if host.Endpoint() == "" {
		t.Fatal("启动成功后必须暴露自有端点")
	}
	host.opts.Environ = func() []string {
		return append(os.Environ(), fixtureEnv+"=fail-listen")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err == nil {
		t.Fatal("就绪失败的重启不得报告成功")
	}
	if host.Running() || host.Endpoint() != "" {
		t.Fatal("重启失败后不得留下可复用端点")
	}
}

func TestRelaunchDoesNotTalkToOldChild(t *testing.T) {
	host := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	firstPID := host.PID()
	firstURL := host.Endpoint()
	if firstPID == 0 || firstURL == "" {
		t.Fatal("需要已就绪的第一代子进程")
	}
	if err := host.Restart(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	if host.PID() == firstPID || host.Endpoint() == firstURL {
		t.Fatalf("重启必须换新实例 pid=%d/%d url=%s/%s", firstPID, host.PID(), firstURL, host.Endpoint())
	}
	resp, err := http.Get(firstURL + "/health")
	if err == nil {
		resp.Body.Close()
		t.Fatal("旧子进程不得继续响应")
	}
}

func TestNewHostCannotAdoptPreviousEndpoint(t *testing.T) {
	first := fixtureHost(t, "http")
	provider := fixtureProvider()
	if err := first.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	owned := first.Endpoint()
	second := New(Options{DataDir: t.TempDir()})
	t.Cleanup(func() { _ = second.Stop() })
	if second.Endpoint() != "" || second.Probe(context.Background()).OK {
		t.Fatal("另一个 Host 不得认领前一个实例的端点")
	}
	if err := first.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get(owned + "/health"); err == nil {
		t.Fatal("停止后旧端点不得仍可访问")
	}
}

func TestProbeRejectsHealthyListenerWithoutMatchingInstance(t *testing.T) {
	foreign, hits := startForeignHealth(t)
	host := New(Options{DataDir: t.TempDir()})
	host.TestingUseOwnedEndpoint(foreign, "owned-nonce-value", "fp")
	health := host.Probe(context.Background())
	if health.OK {
		t.Fatal("实例证明不匹配时不得把外部 /health 当成自有子进程")
	}
	if *hits == 0 {
		t.Fatal("Probe 应打到注入的测试端点并拒绝证明")
	}
	if strings.Contains(fmt.Sprintf("%#v", health), "owned-nonce-value") {
		t.Fatal("Probe 结果不得包含实例 nonce")
	}
}

func TestOwnedHealthJSONOmitsNonce(t *testing.T) {
	host := fixtureHost(t, "http")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatal(err)
	}
	health := host.Probe(context.Background())
	if !health.OK || health.Instance == "" {
		t.Fatalf("自有子进程应通过实例证明: %#v", health)
	}
	req, err := host.NewChildRequest(context.Background(), http.MethodGet, "/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce := req.Header.Get(InstanceHeader)
	if nonce == "" {
		t.Fatal("子进程请求必须带实例 nonce 头")
	}
	resp, err := host.HTTPClient(3 * time.Second).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), nonce) || strings.Contains(fmt.Sprintf("%#v", health), nonce) {
		t.Fatalf("health JSON 或探测结果含 nonce: %s", body)
	}
	if health.Instance == nonce {
		t.Fatal("公开 instance 字段必须是证明而不是 nonce")
	}
}

func TestStopCancelsInFlightAndQueuedStartContext(t *testing.T) {
	host := fixtureHost(t, "sleep")
	host.opts.ReadyTimeout = 10 * time.Second
	host.opts.ResolveProvider = func() (assistant.Provider, string) { return fixtureProvider(), "" }

	// 1. In-flight StartContext must be aborted promptly by Host.Stop().
	startErrCh := make(chan error, 1)
	go func() {
		startErrCh <- host.StartContext(context.Background(), "http://127.0.0.1:18090/api", "")
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if host.State().Starting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !host.State().Starting {
		t.Fatal("expected Host.State().Starting while slow child boots")
	}
	stopBegin := time.Now()
	if err := host.Stop(); err != nil {
		t.Fatalf("Host.Stop failed: %v", err)
	}
	if elapsed := time.Since(stopBegin); elapsed > 2*time.Second {
		t.Fatalf("Host.Stop took %v waiting on in-flight StartContext", elapsed)
	}
	select {
	case err := <-startErrCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("in-flight StartContext error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight StartContext did not return after Host.Stop")
	}
	if host.Running() {
		t.Fatal("host must not be running after Stop")
	}

	// 2. A queued StartContext waiting on lifecycle lock must not relaunch after Stop.
	genCaptured := make(chan struct{}, 1)
	host.startControlMu.Lock()
	host.onStartGenCaptured = func() {
		select {
		case genCaptured <- struct{}{}:
		default:
		}
	}
	host.startControlMu.Unlock()
	t.Cleanup(func() {
		host.startControlMu.Lock()
		host.onStartGenCaptured = nil
		host.startControlMu.Unlock()
	})

	if err := host.lockLifecycle(context.Background()); err != nil {
		t.Fatal(err)
	}
	queuedErrCh := make(chan error, 1)
	go func() {
		queuedErrCh <- host.StartContext(context.Background(), "http://127.0.0.1:18090/api", "")
	}()
	select {
	case <-genCaptured:
	case <-time.After(2 * time.Second):
		host.unlockLifecycle()
		t.Fatal("queued StartContext did not capture generation before unlock")
	}
	host.cancelInFlightStart()
	host.unlockLifecycle()

	select {
	case err := <-queuedErrCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued StartContext error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queued StartContext did not abort after generation bump")
	}
	if host.Running() {
		t.Fatal("queued StartContext must not launch child after Stop")
	}

	// 3. StopContext must also cancel an in-flight Ensure promptly without waiting 10s.
	ensureErrCh := make(chan error, 1)
	go func() {
		_, err := host.Ensure(fixtureProvider(), "http://127.0.0.1:18090/api", "", true)
		ensureErrCh <- err
	}()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if host.State().Starting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !host.State().Starting {
		t.Fatal("expected Host.State().Starting while Ensure boots slow child")
	}
	stopCtxBegin := time.Now()
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelClose()
	if err := host.StopContext(closeCtx); err != nil {
		t.Fatalf("Host.StopContext failed: %v", err)
	}
	if elapsed := time.Since(stopCtxBegin); elapsed > 2*time.Second {
		t.Fatalf("Host.StopContext took %v waiting on in-flight Ensure", elapsed)
	}
	select {
	case err := <-ensureErrCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("in-flight Ensure error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight Ensure did not return after StopContext")
	}
	if host.Running() {
		t.Fatal("host must not be running after StopContext")
	}
}

func TestStopContextRespectsDeadlineOnSIGTERMResistantChildAndNonBlockingEnsure(t *testing.T) {
	dataDir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent_config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dataDir,
		ReadyTimeout: 10 * time.Second,
		ResolveProvider: func() (assistant.Provider, string) {
			return fixtureProvider(), ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=ignore-sigterm-sleep")
		},
	})

	startErrCh := make(chan error, 1)
	go func() {
		startErrCh <- host.StartContext(context.Background(), "http://127.0.0.1:18090/api", "")
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if host.State().Starting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !host.State().Starting {
		t.Fatal("expected Host.State().Starting while SIGTERM-resistant child boots")
	}

	// Ensure while startup is already in flight must return (true, nil)
	// immediately rather than blocking behind the 10s readiness wait.
	ensureBegin := time.Now()
	launched, ensureErr := host.Ensure(fixtureProvider(), "http://127.0.0.1:18090/api", "", true)
	if ensureErr != nil || !launched {
		t.Fatalf("Ensure during in-flight start = (%v, %v), want (true, nil)", launched, ensureErr)
	}
	if elapsed := time.Since(ensureBegin); elapsed > 500*time.Millisecond {
		t.Fatalf("Ensure blocked for %v while startup already in flight", elapsed)
	}

	// StopContext with a short deadline must escalate to SIGKILL quickly rather
	// than stalling 5-8s on a child that ignores SIGTERM.
	stopBegin := time.Now()
	stopCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_ = host.StopContext(stopCtx)
	if elapsed := time.Since(stopBegin); elapsed > 2*time.Second {
		t.Fatalf("StopContext on SIGTERM-resistant child took %v, want <= 2s", elapsed)
	}
	select {
	case err := <-startErrCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("in-flight StartContext error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight StartContext did not return after StopContext")
	}
	if host.Running() {
		t.Fatal("SIGTERM-resistant child still running after StopContext")
	}
}

func TestEnsureAsyncReturnsImmediatelyAndRespectsFailureCooldown(t *testing.T) {
	dir := t.TempDir()
	cfg := HostConfig{HostCommand: filepath.Join(dir, "definitely-missing-agent-host-binary")}
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 1 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return fixtureProvider(), ""
		},
	})
	t.Cleanup(func() { _ = host.Stop() })

	launched, err := host.EnsureAsync(fixtureProvider(), "http://127.0.0.1:18090/api", "")
	if err != nil || !launched {
		t.Fatalf("first EnsureAsync = (%v, %v), want (true, nil)", launched, err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && host.State().Starting {
		time.Sleep(10 * time.Millisecond)
	}
	if host.State().LastError == nil {
		t.Fatal("expected missing binary async launch to record LastError")
	}
	// Second EnsureAsync with the same provider fingerprint during cooldown must
	// immediately return the recorded error instead of looping host_starting forever.
	launched2, err2 := host.EnsureAsync(fixtureProvider(), "http://127.0.0.1:18090/api", "")
	if err2 == nil || launched2 {
		t.Fatalf("second EnsureAsync during failure cooldown = (%v, %v), want (false, err)", launched2, err2)
	}
}

func TestStopDoesNotRespawnConcurrentAsyncLaunch(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 5 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return fixtureProvider(), ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=http")
		},
	})
	t.Cleanup(func() { _ = host.StopContext(context.Background()) })

	// Hammer Stop() concurrently with EnsureAsync/RestartAsync; once Stop returns
	// after callers settle, no stale launch may leave a running child behind.
	var wg sync.WaitGroup
	stopCh := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			for {
				select {
				case <-stopCh:
					return
				default:
					if idx%2 == 0 {
						_, _ = host.EnsureAsync(fixtureProvider(), "http://127.0.0.1:18090/api", "")
					} else {
						_ = host.RestartAsync(fixtureProvider(), "http://127.0.0.1:18090/api", "")
					}
					time.Sleep(2 * time.Millisecond)
				}
			}
		}(i)
	}
	for i := 0; i < 5; i++ {
		time.Sleep(10 * time.Millisecond)
		if err := host.Stop(); err != nil {
			t.Fatalf("Stop #%d failed: %v", i, err)
		}
	}
	close(stopCh)
	wg.Wait()
	if err := host.Stop(); err != nil {
		t.Fatalf("final Stop failed: %v", err)
	}
	if host.Running() || host.PID() != 0 {
		t.Fatalf("host still running after Stop: running=%v pid=%d", host.Running(), host.PID())
	}
}

func TestRestartAsyncSkipsStopWhenHostBecomesBusy(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 5 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return fixtureProvider(), ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=http", "BEEFTV_ASSISTANT_RUNTIME_BUSY=1")
		},
	})
	t.Cleanup(func() { _ = host.StopContext(context.Background()) })

	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("Launch failed: %v", err)
	}
	pidBefore := host.PID()
	if pidBefore == 0 {
		t.Fatal("expected running fixture child PID")
	}
	nextProvider := fixtureProvider()
	nextProvider.Model = "fixture-model-next"
	if err := host.RestartAsync(nextProvider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("RestartAsync failed: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && host.State().Starting {
		time.Sleep(10 * time.Millisecond)
	}
	if !host.Running() || host.PID() != pidBefore {
		t.Fatalf("RestartAsync stopped a busy host: running=%v pid=%d want %d", host.Running(), host.PID(), pidBefore)
	}
}

func TestEnsureAsyncReturnsTrueWhenAnotherAsyncLaunchIsAlreadyRegistered(t *testing.T) {
	dir := t.TempDir()
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: "/bin/echo"})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	host := New(Options{
		DataDir: dir,
		ResolveProvider: func() (assistant.Provider, string) {
			return fixtureProvider(), ""
		},
	})
	// Simulate another async launch occupying asyncDone at tryBeginAsyncLaunch
	// (even if State().Starting were read right after it completes).
	_, done, outcome := host.tryBeginAsyncLaunch(false)
	if outcome != asyncLaunchAdmitted {
		t.Fatalf("first tryBeginAsyncLaunch outcome = %v, want admitted", outcome)
	}
	defer host.finishAsyncLaunch(done)
	if _, _, outcome2 := host.tryBeginAsyncLaunch(false); outcome2 != asyncLaunchAlreadyActive {
		t.Fatalf("second tryBeginAsyncLaunch outcome = %v, want alreadyActive", outcome2)
	}
	launched, err := host.EnsureAsync(fixtureProvider(), "http://127.0.0.1:18090/api", "")
	if err != nil || !launched {
		t.Fatalf("EnsureAsync while another async launch active = (%v, %v), want (true, nil)", launched, err)
	}
}

func TestEnsureAsyncFastReturnsStartingBeforeFailureCooldown(t *testing.T) {
	dir := t.TempDir()
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: "/bin/echo"})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fixtureProvider()
	host := New(Options{
		DataDir: dir,
		ResolveProvider: func() (assistant.Provider, string) {
			return provider, ""
		},
	})
	host.proc.mu.Lock()
	host.proc.starting = true
	host.proc.lastErr = errors.New("stale start failure")
	host.proc.failedFingerprint = provider.Fingerprint()
	host.proc.failedAt = time.Now()
	host.proc.mu.Unlock()

	launched, err := host.EnsureAsync(provider, "http://127.0.0.1:18090/api", "")
	if err != nil || !launched {
		t.Fatalf("EnsureAsync while Starting during cooldown = (%v, %v), want (true, nil)", launched, err)
	}
}

func TestUnexpectedHostExitRecordsLastErrorWithoutCooldown(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fixtureProvider()
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 5 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return provider, ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=http")
		},
	})
	t.Cleanup(func() { _ = host.Stop() })

	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("Launch failed: %v", err)
	}
	pid := host.PID()
	proc, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := proc.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && host.Running() {
		time.Sleep(15 * time.Millisecond)
	}
	state := host.State()
	if state.Running {
		t.Fatal("host still reported running after kill")
	}
	if state.LastError == nil {
		t.Fatal("expected unexpected crash to record State.LastError")
	}
	if !state.FailedAt.IsZero() {
		t.Fatalf("unexpected post-ready crash should not enter startup cooldown: FailedAt=%v", state.FailedAt)
	}
	launched, err := host.EnsureAsync(provider, "http://127.0.0.1:18090/api", "")
	if err != nil || !launched {
		t.Fatalf("EnsureAsync after unexpected crash = (%v, %v), want (true, nil)", launched, err)
	}
}

func TestIntentionalStopAndRestartLeavesLastErrorClear(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fixtureProvider()
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 5 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return provider, ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=http")
		},
	})
	t.Cleanup(func() { _ = host.Stop() })

	for i := 0; i < 2; i++ {
		if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
			t.Fatalf("Launch #%d failed: %v", i+1, err)
		}
		if err := host.Stop(); err != nil {
			t.Fatalf("Stop #%d failed: %v", i+1, err)
		}
		state := host.State()
		if state.Running || state.LastError != nil {
			t.Fatalf("intentional Stop #%d left unexpected state: running=%v lastErr=%v", i+1, state.Running, state.LastError)
		}
	}
}

func TestStopClearsPriorCrashErrorAndLateExitOfStoppedChildDoesNotCorruptNewActive(t *testing.T) {
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(HostConfig{Model: "fixture-model", HostCommand: exe})
	if err := os.WriteFile(filepath.Join(dir, hostConfigFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fixtureProvider()
	host := New(Options{
		DataDir:      dir,
		ReadyTimeout: 5 * time.Second,
		HostToken:    func() string { return "tok" },
		ResolveProvider: func() (assistant.Provider, string) {
			return provider, ""
		},
		Environ: func() []string {
			return append(os.Environ(), fixtureEnv+"=http")
		},
	})
	t.Cleanup(func() { _ = host.Stop() })

	// 1) Even if a process crashes right before Host.Stop() runs, Stop clears LastError.
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("Launch #1 failed: %v", err)
	}
	if proc, err := os.FindProcess(host.PID()); err == nil {
		_ = proc.Kill()
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && host.Running() {
		time.Sleep(15 * time.Millisecond)
	}
	if host.State().LastError == nil {
		t.Fatal("expected crash before Stop to record LastError")
	}
	if err := host.Stop(); err != nil {
		t.Fatalf("Stop after crash failed: %v", err)
	}
	if got := host.State().LastError; got != nil {
		t.Fatalf("Host.Stop did not clear prior crash LastError: %v", got)
	}

	// 2) Launch a fresh process; invoke the real finishChildExit bookkeeping for a stale
	//    child (both stopping and non-stopping) and confirm the active child remains healthy
	//    and State.LastError stays nil (fails if s.active == owned guard is removed).
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("Launch #2 failed: %v", err)
	}
	newPID := host.PID()
	stale := &childProcess{done: make(chan struct{}), ready: true}
	host.proc.finishChildExit(stale, errors.New("late exit after timeout"))
	close(stale.done)
	if !host.Running() || host.PID() != newPID || host.State().LastError != nil {
		t.Fatalf("stale child finishChildExit corrupted active state: running=%v pid=%d want=%d lastErr=%v", host.Running(), host.PID(), newPID, host.State().LastError)
	}
}
