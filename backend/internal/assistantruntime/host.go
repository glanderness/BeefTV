// Package assistantruntime owns the built-in assistant host child process:
// config, env, start/stop, and idle restart. HTTP handlers decode and respond;
// bootstrap owns each Host lifetime. Separate Host values do not share a child.
package assistantruntime

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assistant"
)

// Options 是 Host 的可注入边界：配置、供应商解析、凭据与进程环境。
type Options struct {
	DataDir         string
	ResolveProvider func() (assistant.Provider, string)
	HostToken       func() string
	OwnerToken      func() string
	Environ         func() []string
	BackendAddr     func() string
	Executable      func() (string, error)
	GOOS            string
	ReadyTimeout    time.Duration
	RoundTripper    http.RoundTripper
}

// Host 是一个助手宿主监督器实例。bootstrap 为每个运行时持有一个；
// 路由通过 RuntimeDependencies 拿到同一实例，而不是进程级全局变量。
type Host struct {
	opts               Options
	proc               *supervisor
	lifecycleOnce      sync.Once
	lifecycle          chan struct{}
	startControlMu     sync.Mutex
	startGen           uint64
	activeStartCancel  context.CancelFunc
	onStartGenCaptured func()
	opsPipeMu          sync.RWMutex
	opsPipe            string
	closed             bool
	stoppingCount      int
	asyncDone          chan struct{}
}

func New(opts Options) *Host {
	h := &Host{opts: opts, proc: &supervisor{}}
	_ = h.lifecycleChan()
	return h
}

func (h *Host) lifecycleChan() chan struct{} {
	h.lifecycleOnce.Do(func() {
		h.lifecycle = make(chan struct{}, 1)
	})
	return h.lifecycle
}

func (h *Host) lockLifecycle(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	ch := h.lifecycleChan()
	select {
	case ch <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Host) unlockLifecycle() {
	<-h.lifecycleChan()
}

func (h *Host) isClosed() bool {
	h.startControlMu.Lock()
	closed := h.closed
	h.startControlMu.Unlock()
	return closed
}

func (h *Host) markClosedAndCancelStart() chan struct{} {
	h.startControlMu.Lock()
	h.closed = true
	h.startGen++
	cancel := h.activeStartCancel
	h.activeStartCancel = nil
	done := h.asyncDone
	h.startControlMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return done
}

func (h *Host) isAsyncStarting() bool {
	h.startControlMu.Lock()
	starting := h.asyncDone != nil
	h.startControlMu.Unlock()
	return starting
}

func (h *Host) asyncLaunchDone() chan struct{} {
	h.startControlMu.Lock()
	done := h.asyncDone
	h.startControlMu.Unlock()
	return done
}

type asyncLaunchOutcome int

const (
	asyncLaunchAdmitted asyncLaunchOutcome = iota
	asyncLaunchAlreadyActive
	asyncLaunchStopping
	asyncLaunchClosed
)

func (h *Host) tryBeginAsyncLaunch(cancelExisting bool) (gen uint64, done chan struct{}, outcome asyncLaunchOutcome) {
	h.startControlMu.Lock()
	if h.closed {
		h.startControlMu.Unlock()
		return 0, nil, asyncLaunchClosed
	}
	if h.stoppingCount > 0 {
		h.startControlMu.Unlock()
		return 0, nil, asyncLaunchStopping
	}
	if h.asyncDone != nil || (!cancelExisting && h.proc.state().Starting) {
		h.startControlMu.Unlock()
		return 0, nil, asyncLaunchAlreadyActive
	}
	var cancel context.CancelFunc
	if cancelExisting {
		h.startGen++
		cancel = h.activeStartCancel
		h.activeStartCancel = nil
	}
	gen = h.startGen
	done = make(chan struct{})
	h.asyncDone = done
	hook := h.onStartGenCaptured
	h.startControlMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if hook != nil {
		hook()
	}
	return gen, done, asyncLaunchAdmitted
}

func (h *Host) finishAsyncLaunch(done chan struct{}) {
	h.startControlMu.Lock()
	if h.asyncDone == done {
		h.asyncDone = nil
	}
	h.startControlMu.Unlock()
	close(done)
}

func OptionsFromService(svc ProviderService) Options {
	if svc == nil {
		return Options{ResolveProvider: func() (assistant.Provider, string) {
			return ResolveProvider(nil)
		}}
	}
	return Options{
		DataDir: svc.DataDir(),
		ResolveProvider: func() (assistant.Provider, string) {
			return ResolveProvider(svc.ResolveAssistantProvider)
		},
	}
}

func (h *Host) dataDir() string {
	if h == nil {
		return ""
	}
	return h.opts.DataDir
}

func (h *Host) goos() string {
	if h != nil && strings.TrimSpace(h.opts.GOOS) != "" {
		return h.opts.GOOS
	}
	return runtime.GOOS
}

func (h *Host) executablePath() string {
	if h != nil && h.opts.Executable != nil {
		path, err := h.opts.Executable()
		if err != nil {
			return ""
		}
		return path
	}
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}

func (h *Host) State() State {
	if h == nil {
		return State{}
	}
	st := h.proc.state()
	if !st.Starting && h.isAsyncStarting() {
		st.Starting = true
	}
	return st
}

func (h *Host) Running() bool {
	return h != nil && h.proc.running()
}

func (h *Host) PID() int {
	if h == nil {
		return 0
	}
	return h.proc.pid()
}

// Endpoint is the supervisor-owned loopback URL. Empty until this Host has
// launched a child and health has proved the instance nonce.
func (h *Host) Endpoint() string {
	if h == nil {
		return ""
	}
	endpoint, _ := h.proc.identity()
	return endpoint
}

// SetOpsPipe records the local IPC endpoint of the owning desktop workspace so
// launched agent-host processes can reach /api/ops without relying on loopback TCP.
func (h *Host) SetOpsPipe(pipePath string) {
	if h == nil {
		return
	}
	h.opsPipeMu.Lock()
	h.opsPipe = strings.TrimSpace(pipePath)
	h.opsPipeMu.Unlock()
}

func (h *Host) opsPipePath() string {
	if h == nil {
		return ""
	}
	h.opsPipeMu.RLock()
	defer h.opsPipeMu.RUnlock()
	return h.opsPipe
}

func (h *Host) readyTimeout() time.Duration {
	if h != nil && h.opts.ReadyTimeout > 0 {
		return h.opts.ReadyTimeout
	}
	return defaultReadyTimeout
}

// TestingUseOwnedEndpoint injects a loopback child for handler tests. Production
// never reads BEEFTV_AGENT_HOST_URL or :18500 as a fallback.
func (h *Host) TestingUseOwnedEndpoint(baseURL, nonce, fingerprint string) {
	if h == nil {
		return
	}
	h.proc.testingUseEndpoint(baseURL, nonce, fingerprint)
}

// Start 在应用启动时按本机配置拉起内置宿主。
// 未配置启动命令或模型/凭据还没解析出来时是 no-op（用户没配好助手不应该让应用启动失败）；
// 之后界面查询 /assistant/status 会按当时的配置补上这次启动。
func (h *Host) Start(opsURL, desktopToken string) error {
	return h.StartContext(context.Background(), opsURL, desktopToken)
}

// StartContext 与 Start 相同，但允许调用方（以及 Stop/StopContext/Restart）提前取消子进程就绪等待。
func (h *Host) StartContext(ctx context.Context, opsURL, desktopToken string) error {
	if h == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	gen := h.captureStartGen()
	if err := h.lockLifecycle(ctx); err != nil {
		return err
	}
	defer h.unlockLifecycle()
	if err := ctx.Err(); err != nil {
		return err
	}
	startCtx, cleanupStart, ok := h.beginStartLocked(ctx, gen)
	if !ok {
		return context.Canceled
	}
	defer cleanupStart()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return nil
	}
	provider, reason := h.ResolveProvider()
	if reason != "" {
		return nil
	}
	return h.startOwned(startCtx, config, provider, opsURL, desktopToken)
}

func (h *Host) captureStartGen() uint64 {
	h.startControlMu.Lock()
	gen := h.startGen
	hook := h.onStartGenCaptured
	h.startControlMu.Unlock()
	if hook != nil {
		hook()
	}
	return gen
}

func (h *Host) beginStartLocked(parent context.Context, expectedGen uint64) (context.Context, func(), bool) {
	h.startControlMu.Lock()
	if h.closed || h.stoppingCount > 0 || h.startGen != expectedGen {
		h.startControlMu.Unlock()
		return nil, nil, false
	}
	startCtx, cancel := context.WithCancel(parent)
	h.activeStartCancel = cancel
	h.startControlMu.Unlock()
	return startCtx, func() {
		h.startControlMu.Lock()
		if h.startGen == expectedGen {
			h.activeStartCancel = nil
		}
		h.startControlMu.Unlock()
		cancel()
	}, true
}

func (h *Host) cancelInFlightStart() {
	h.startControlMu.Lock()
	h.startGen++
	cancel := h.activeStartCancel
	h.activeStartCancel = nil
	h.startControlMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Launch 按已解析的供应商启动；已在跑则是 no-op。调用方负责先检查配置是否存在。
func (h *Host) Launch(provider assistant.Provider, opsURL, desktopToken string) error {
	if h == nil {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	gen := h.captureStartGen()
	if err := h.lockLifecycle(context.Background()); err != nil {
		return err
	}
	defer h.unlockLifecycle()
	startCtx, cleanupStart, ok := h.beginStartLocked(context.Background(), gen)
	if !ok {
		if h.isClosed() {
			return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
		}
		return context.Canceled
	}
	defer cleanupStart()
	return h.launchLocked(startCtx, provider, opsURL, desktopToken)
}

func (h *Host) launchLocked(ctx context.Context, provider assistant.Provider, opsURL, desktopToken string) error {
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	return h.startOwned(ctx, config, provider, opsURL, desktopToken)
}

func (h *Host) Stop() error {
	if h == nil {
		return nil
	}
	h.startControlMu.Lock()
	h.stoppingCount++
	h.startGen++
	cancel := h.activeStartCancel
	h.activeStartCancel = nil
	done := h.asyncDone
	h.startControlMu.Unlock()
	defer func() {
		h.startControlMu.Lock()
		h.stoppingCount--
		h.startControlMu.Unlock()
	}()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	_ = h.lockLifecycle(context.Background())
	defer h.unlockLifecycle()
	err := h.proc.stop()
	h.proc.clearFailure()
	return err
}

// StopContext 在应用关闭时停止**本 Host 启动的**内置宿主子进程。
//
// 只对它自己启动过的进程生效（未启动时是 no-op），不会去清理外接宿主或别人的 PID；
// 宿主不可达/已退出时返回 nil，避免把关闭流程拖成失败。
// 关闭标记在抢锁之前原子写入，确保不会再拉起新进程；ctx 到期时会立即升级 SIGKILL。
func (h *Host) StopContext(ctx context.Context) error {
	if h == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	done := h.markClosedAndCancelStart()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
		}
	}
	if err := h.lockLifecycle(ctx); err != nil {
		// Force-kill any stubborn child that hasn't exited yet without waiting
		// indefinitely for lifecycle handoff.
		_ = h.proc.stopContext(ctx)
		return fmt.Errorf("停止内置创作助手宿主超时：%w", err)
	}
	defer h.unlockLifecycle()
	if !h.proc.running() {
		return nil
	}
	if err := h.proc.stopContext(ctx); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("停止内置创作助手宿主超时：%w", ctx.Err())
		}
		return fmt.Errorf("停止内置创作助手宿主：%w", err)
	}
	return nil
}

// EnsureFresh coordinates with any in-flight start/restart and synchronously
// restarts an idle running child when its provider or proxy environment has
// drifted. Busy or unhealthy children are left untouched, and once a restart
// begins its child startup is detached from the caller request context so an
// aborted chat request cannot leave the host stopped.
func (h *Host) EnsureFresh(ctx context.Context, provider assistant.Provider, opsURL, desktopToken string) (restarted bool, err error) {
	if h == nil {
		return false, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if done := h.asyncLaunchDone(); done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
	st := h.State()
	if !st.Starting && (!st.Running || st.TestOwned || !h.needsRestartState(st, provider)) {
		return false, nil
	}
	if h.isClosed() {
		return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	if err := h.lockLifecycle(ctx); err != nil {
		return false, err
	}
	defer h.unlockLifecycle()
	state := h.proc.state()
	if !state.Running || state.TestOwned || !h.needsRestartState(state, provider) {
		return false, nil
	}
	health := h.Probe(ctx)
	if !health.OK || health.Busy {
		return false, nil
	}
	h.cancelInFlightStart()
	gen := h.captureStartGen()
	startCtx, cleanupStart, ok := h.beginStartLocked(context.Background(), gen)
	if !ok {
		if h.isClosed() {
			return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
		}
		return false, nil
	}
	defer cleanupStart()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if stopErr := h.proc.stop(); stopErr != nil {
		return false, stopErr
	}
	if startErr := h.startOwned(startCtx, config, provider, opsURL, desktopToken); startErr != nil {
		return false, startErr
	}
	return true, nil
}

// Ensure 让状态查询自己把宿主带起来：
// 没跑就按当前配置启动；跑着但供应商指纹变了、而且此刻空闲，就重启到新配置。
// 返回 launched=true 表示这次调用刚拉起进程（或已有异步启动在进行，界面此时应显示 host_starting）。
func (h *Host) Ensure(provider assistant.Provider, opsURL, desktopToken string, idle bool) (launched bool, err error) {
	if h == nil {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if h.isClosed() {
		return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	if h.State().Starting {
		return true, nil
	}
	gen := h.captureStartGen()
	return h.ensureStart(gen, provider, opsURL, desktopToken, idle)
}

// NeedsRestart reports whether a running child process is out of date with
// either the resolved provider configuration or the active proxy environment.
func (h *Host) NeedsRestart(provider assistant.Provider) bool {
	if h == nil {
		return false
	}
	return h.needsRestartState(h.proc.state(), provider)
}

// NeedsProxyRestart reports specifically whether a running child process has a
// stale proxy environment compared to the active desktopnet configuration.
func (h *Host) NeedsProxyRestart(provider assistant.Provider) bool {
	if h == nil {
		return false
	}
	state := h.proc.state()
	return state.Running && state.ProxyFingerprint != "" && state.ProxyFingerprint != h.proxyFingerprint(provider)
}

func (h *Host) needsRestartState(state State, provider assistant.Provider) bool {
	if !state.Running {
		return false
	}
	if state.Fingerprint != "" && state.Fingerprint != provider.Fingerprint() {
		return true
	}
	if state.ProxyFingerprint != "" && state.ProxyFingerprint != h.proxyFingerprint(provider) {
		return true
	}
	return false
}

func (h *Host) ensureStart(gen uint64, provider assistant.Provider, opsURL, desktopToken string, idle bool) (launched bool, err error) {
	if err := h.lockLifecycle(context.Background()); err != nil {
		return false, err
	}
	defer h.unlockLifecycle()
	startCtx, cleanupStart, ok := h.beginStartLocked(context.Background(), gen)
	if !ok {
		if h.isClosed() {
			return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
		}
		return false, context.Canceled
	}
	defer cleanupStart()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	state := h.proc.state()
	if state.Running {
		if !h.needsRestartState(state, provider) || !idle {
			return false, nil
		}
		if stopErr := h.proc.stop(); stopErr != nil {
			return false, stopErr
		}
	}
	if startErr := h.startOwned(startCtx, config, provider, opsURL, desktopToken); startErr != nil {
		return false, startErr
	}
	return true, nil
}

func (h *Host) startOwned(ctx context.Context, config HostConfig, provider assistant.Provider, opsURL, desktopToken string) error {
	if h.isClosed() {
		return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	opsPipe := h.opsPipePath()
	return h.proc.startOwned(ctx, config, provider.Fingerprint(), h.readyTimeout(), func(port int, nonce, listenFD, listenPipe string) ([]string, string) {
		return h.buildEnvWithProxyFingerprint(provider, childPin{
			Port:       port,
			Nonce:      nonce,
			ListenFD:   listenFD,
			ListenPipe: listenPipe,
			OpsPipe:    opsPipe,
			Lifetime:   true,
			OpsURL:     opsURL,
			DesktopTok: desktopToken,
		})
	}, h.hostToken())
}

const asyncStartFailureCooldown = 15 * time.Second

// EnsureAsync 在后台异步拉起未运行的宿主，不阻塞 /assistant/status HTTP 轮询。
// 缺少启动命令或同一配置刚失败过（冷却期内）时立即返回错误，避免状态轮询无限重试。
func (h *Host) EnsureAsync(provider assistant.Provider, opsURL, desktopToken string) (launched bool, err error) {
	if h == nil {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if h.isClosed() {
		return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return false, invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	state := h.proc.state()
	if state.Running {
		return false, nil
	}
	if state.Starting {
		return true, nil
	}
	if state.LastError != nil && state.FailedFingerprint == provider.Fingerprint() && time.Since(state.FailedAt) < asyncStartFailureCooldown {
		return false, state.LastError
	}
	gen, done, outcome := h.tryBeginAsyncLaunch(false)
	switch outcome {
	case asyncLaunchClosed:
		return false, invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	case asyncLaunchAlreadyActive:
		return true, nil
	case asyncLaunchStopping:
		return false, nil
	}
	go func() {
		defer h.finishAsyncLaunch(done)
		_, _ = h.ensureStart(gen, provider, opsURL, desktopToken, true)
	}()
	return true, nil
}

// RestartAsync 在后台异步重启宿主到新供应商配置，避免 /assistant/status 同步阻塞超过前端超时。
// 在真正停旧进程前会于 lifecycle 锁内复检 busy，避免打断探测之后刚刚开始的新回合。
func (h *Host) RestartAsync(provider assistant.Provider, opsURL, desktopToken string) error {
	if h == nil {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if h.isClosed() {
		return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	gen, done, outcome := h.tryBeginAsyncLaunch(true)
	if outcome == asyncLaunchClosed {
		return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
	}
	if outcome != asyncLaunchAdmitted {
		return nil
	}
	h.proc.clearFailure()
	go func() {
		defer h.finishAsyncLaunch(done)
		_ = h.restartWithGen(gen, provider, opsURL, desktopToken, true)
	}()
	return nil
}

// Restart 是「重试」按钮的真实动作：停掉旧进程再按当前配置启动。
func (h *Host) Restart(provider assistant.Provider, opsURL, desktopToken string) error {
	if h == nil {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	h.proc.clearFailure()
	h.cancelInFlightStart()
	gen := h.captureStartGen()
	return h.restartWithGen(gen, provider, opsURL, desktopToken, false)
}

func (h *Host) restartWithGen(gen uint64, provider assistant.Provider, opsURL, desktopToken string, skipIfBusy bool) error {
	if err := h.lockLifecycle(context.Background()); err != nil {
		return err
	}
	defer h.unlockLifecycle()
	startCtx, cleanupStart, ok := h.beginStartLocked(context.Background(), gen)
	if !ok {
		if h.isClosed() {
			return invalidArg("host_stopping", "应用正在退出，不能启动助手宿主")
		}
		return context.Canceled
	}
	defer cleanupStart()
	config, configured := h.EffectiveConfig()
	if !configured || strings.TrimSpace(config.HostCommand) == "" {
		return invalidArg("host_command_missing", "未配置宿主启动命令")
	}
	if skipIfBusy && h.proc.running() {
		if health := h.Probe(startCtx); health.OK && health.Busy {
			return nil
		}
	}
	if err := h.proc.stop(); err != nil {
		return err
	}
	return h.startOwned(startCtx, config, provider, opsURL, desktopToken)
}
