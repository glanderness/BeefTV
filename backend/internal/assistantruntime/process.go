package assistantruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"infinite-canvas/backend/internal/localipc"
)

const defaultReadyTimeout = 20 * time.Second

// childProcess 绑定单次启动的子进程句柄与显式生命周期标记，防止迟退出的旧进程
// 误判为新进程崩溃，也消除 health 通过到 endpoint 公布之间的窄窗口竞态。
type childProcess struct {
	cmd      *exec.Cmd
	done     chan struct{}
	stopping bool
	ready    bool
	exited   bool
	waitErr  error
}

func unexpectedHostExitError(waitErr error) error {
	if waitErr != nil {
		return fmt.Errorf("宿主进程意外退出: %w", waitErr)
	}
	return errors.New("宿主进程意外退出")
}

func (s *supervisor) finishChildExit(owned *childProcess, waitErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owned.exited = true
	owned.waitErr = waitErr
	if s.active != owned {
		return
	}
	pipeMode := s.pipeMode
	pid := 0
	if owned.cmd != nil && owned.cmd.Process != nil {
		pid = owned.cmd.Process.Pid
	}
	s.clearIdentityLocked()
	s.active = nil
	if !owned.stopping {
		if owned.ready {
			s.lastErr = unexpectedHostExitError(waitErr)
			log.Printf("assistantruntime: agent-host exited unexpectedly (pid=%d, pipe=%v): %v", pid, pipeMode, waitErr)
		} else {
			log.Printf("assistantruntime: agent-host exited before ready (pid=%d, pipe=%v): %v", pid, pipeMode, waitErr)
		}
	}
}

// supervisor 持有本实例启动的子进程、回环端点与实例 nonce。
// 端点只在本进程就绪且 health 证明 nonce 之后才暴露；绝不把全局端口或别人的 PID 当成所有权。
type supervisor struct {
	mu                sync.Mutex
	active            *childProcess
	starting          bool
	fingerprint       string
	proxyFingerprint  string
	launchedAt        time.Time
	lastErr           error
	failedFingerprint string
	failedAt          time.Time
	endpoint          string
	pipePath          string
	pipeMode          bool
	nonce             string
	lifetimeW         *os.File
	testOwned         bool
}

// State 是状态查询需要的宿主进程事实（不含 nonce 或其它凭据）。
type State struct {
	Running           bool
	Starting          bool
	Fingerprint       string
	ProxyFingerprint  string
	LaunchedAt        time.Time
	LastError         error
	FailedFingerprint string
	FailedAt          time.Time
	Endpoint          string
	TestOwned         bool
}

func (s *supervisor) state() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return State{
		Running:           s.isRunningLocked(),
		Starting:          s.starting,
		Fingerprint:       s.fingerprint,
		ProxyFingerprint:  s.proxyFingerprint,
		LaunchedAt:        s.launchedAt,
		LastError:         s.lastErr,
		FailedFingerprint: s.failedFingerprint,
		FailedAt:          s.failedAt,
		Endpoint:          s.endpoint,
		TestOwned:         s.testOwned,
	}
}

func (s *supervisor) clearFailure() {
	s.mu.Lock()
	s.lastErr = nil
	s.failedFingerprint = ""
	s.failedAt = time.Time{}
	s.mu.Unlock()
}

func (s *supervisor) isRunningLocked() bool {
	if s.testOwned && s.endpoint != "" && s.nonce != "" {
		return true
	}
	if s.active == nil || s.active.cmd == nil || s.active.cmd.Process == nil {
		return false
	}
	select {
	case <-s.active.done:
		return false
	default:
		return true
	}
}

func (s *supervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isRunningLocked()
}

func (s *supervisor) pid() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil || s.active.cmd == nil || s.active.cmd.Process == nil {
		return 0
	}
	return s.active.cmd.Process.Pid
}

func (s *supervisor) identity() (endpoint, nonce string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isRunningLocked() {
		return "", ""
	}
	return s.endpoint, s.nonce
}

func (s *supervisor) pipeEndpoint() string {
	ep, _ := s.dialTarget()
	return ep
}

func (s *supervisor) dialTarget() (pipePath string, pipeOnly bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isRunningLocked() {
		return "", s.pipeMode
	}
	return s.pipePath, s.pipeMode || s.pipePath != ""
}

func commandParts(config HostConfig) ([]string, error) {
	parts := strings.Fields(config.HostCommand)
	// Packaged paths (including Program Files) are executable names, never shell text.
	if config.HostArgs != nil {
		parts = append([]string{config.HostCommand}, config.HostArgs...)
	} else if info, err := os.Stat(config.HostCommand); err == nil && !info.IsDir() {
		parts = []string{config.HostCommand}
	}
	if len(parts) == 0 {
		return nil, invalidArg("empty_host_command", "未配置宿主启动命令")
	}
	return parts, nil
}

func pipeSyntheticBaseURL(pipePath string) string {
	sum := sha256.Sum256([]byte(pipePath))
	return "http://pipe-" + hex.EncodeToString(sum[:8]) + ".invalid"
}

func (s *supervisor) startOwned(ctx context.Context, config HostConfig, fingerprint string, timeout time.Duration, envFor func(port int, nonce, listenFD, listenPipe string) ([]string, string), token string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	if s.isRunningLocked() && !s.testOwned {
		s.mu.Unlock()
		return nil
	}
	if s.testOwned {
		s.clearIdentityLocked()
	}
	s.starting = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.starting = false
		s.mu.Unlock()
	}()

	nonce, err := randomNonce()
	if err != nil {
		return err
	}

	var (
		listener   net.Listener
		listenFile *os.File
		port       int
		baseURL    string
		listenFD   string
		listenPipe string
	)
	if candidatePipe := localipc.AgentHostEndpoint(); candidatePipe != "" {
		listenPipe = candidatePipe
		baseURL = pipeSyntheticBaseURL(candidatePipe)
	} else {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		port = listener.Addr().(*net.TCPAddr).Port
		baseURL = "http://127.0.0.1:" + strconv.Itoa(port)
		if inheritedListenFD != "" {
			tcp, ok := listener.(*net.TCPListener)
			if !ok {
				_ = listener.Close()
				return errors.New("宿主监听套接字类型无效")
			}
			listenFile, err = tcp.File()
			if err != nil {
				_ = listener.Close()
				return err
			}
			listenFD = inheritedListenFD
		} else {
			_ = listener.Close()
			listener = nil
		}
	}

	lifetimeR, lifetimeW, err := os.Pipe()
	if err != nil {
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}

	parts, err := commandParts(config)
	if err != nil {
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	ConfigureHostProcess(cmd)
	childEnv, proxyFingerprint := envFor(port, nonce, listenFD, listenPipe)
	cmd.Env = childEnv
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Stdin = lifetimeR
	cmd.ExtraFiles = extraListenFiles(listenFile)

	s.mu.Lock()
	if err := ctx.Err(); err != nil {
		s.mu.Unlock()
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}
	if s.isRunningLocked() && !s.testOwned {
		s.mu.Unlock()
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return nil
	}
	if err := cmd.Start(); err != nil {
		s.lastErr = err
		s.failedFingerprint = fingerprint
		s.failedAt = time.Now()
		s.mu.Unlock()
		_ = lifetimeR.Close()
		_ = lifetimeW.Close()
		if listenFile != nil {
			_ = listenFile.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
		return err
	}
	_ = lifetimeR.Close()
	if listenFile != nil {
		_ = listenFile.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	owned := &childProcess{
		cmd:  cmd,
		done: make(chan struct{}),
	}
	s.active = owned
	s.fingerprint = fingerprint
	s.proxyFingerprint = proxyFingerprint
	s.launchedAt = time.Now()
	s.lastErr = nil
	s.nonce = nonce
	s.endpoint = ""
	s.pipePath = listenPipe
	s.pipeMode = listenPipe != ""
	s.lifetimeW = lifetimeW
	s.testOwned = false
	go func() {
		waitErr := owned.cmd.Wait()
		s.finishChildExit(owned, waitErr)
		close(owned.done)
	}()
	s.mu.Unlock()

	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	if err := waitChildReady(ctx, baseURL, listenPipe, nonce, token, timeout, owned.done); err != nil {
		s.mu.Lock()
		s.lastErr = err
		if ctx.Err() == nil {
			s.failedFingerprint = fingerprint
			s.failedAt = time.Now()
		}
		s.mu.Unlock()
		if ctx.Err() != nil {
			cancelStopCtx, cancelStop := context.WithTimeout(context.Background(), 500*time.Millisecond)
			_ = s.stopContext(cancelStopCtx)
			cancelStop()
		} else {
			_ = s.stop()
		}
		return err
	}
	s.mu.Lock()
	if s.active == owned && !owned.exited && !owned.stopping {
		owned.ready = true
		s.endpoint = baseURL
		s.pipePath = listenPipe
		s.lastErr = nil
		s.failedFingerprint = ""
		s.failedAt = time.Time{}
		s.mu.Unlock()
		return nil
	}
	stopping := owned.stopping
	exitErr := unexpectedHostExitError(owned.waitErr)
	if !stopping && s.active == nil {
		s.lastErr = exitErr
		log.Printf("assistantruntime: agent-host exited immediately after health check: %v", owned.waitErr)
	}
	s.mu.Unlock()
	if stopping {
		return context.Canceled
	}
	return exitErr
}

func waitChildReady(ctx context.Context, baseURL, pipePath, nonce, token string, timeout time.Duration, done <-chan struct{}) error {
	if ctx == nil {
		ctx = context.Background()
	}
	pipePath = strings.TrimSpace(pipePath)
	pipeTightened := pipePath == ""
	deadline := time.Now().Add(timeout)
	waitRetry := func() error {
		timer := time.NewTimer(20 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("宿主进程在就绪前退出")
		case <-timer.C:
			return nil
		}
	}
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return errors.New("宿主进程在就绪前退出")
		default:
		}
		if !pipeTightened {
			if err := localipc.TightenEndpointSecurity(pipePath); err != nil {
				if localipc.IsTransientSecurityError(err) {
					if waitErr := waitRetry(); waitErr != nil {
						return waitErr
					}
					continue
				}
				return fmt.Errorf("收紧本地命名管道权限失败: %w", err)
			}
			pipeTightened = true
		}
		probeCtx, cancel := context.WithTimeout(ctx, 400*time.Millisecond)
		health := probeOwned(probeCtx, baseURL, pipePath, nonce, token)
		cancel()
		if health.OK && health.Instance == InstanceProof(nonce) {
			return nil
		}
		if waitErr := waitRetry(); waitErr != nil {
			return waitErr
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return errors.New("宿主进程在就绪前退出")
	default:
		return errors.New("宿主未在时限内就绪")
	}
}

func (s *supervisor) stop() error {
	return s.stopContext(context.Background())
}

func (s *supervisor) stopContext(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopLocked(ctx)
}

func (s *supervisor) stopLocked(ctx context.Context) error {
	if s.testOwned {
		s.clearIdentityLocked()
		return nil
	}
	owned := s.active
	if owned == nil || owned.cmd == nil || owned.cmd.Process == nil {
		s.clearIdentityLocked()
		return nil
	}
	owned.stopping = true
	cmd := owned.cmd
	if s.lifetimeW != nil {
		_ = s.lifetimeW.Close()
		s.lifetimeW = nil
	}
	forceKillNow := runtime.GOOS == "windows" || ctx.Err() != nil
	if forceKillNow {
		_ = cmd.Process.Kill()
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	done := owned.done
	s.mu.Unlock()
	var waitErr error
	if done != nil {
		if forceKillNow {
			select {
			case <-done:
			case <-time.After(1 * time.Second):
				waitErr = errors.New("宿主进程未在超时内退出")
			}
		} else {
			graceTimer := time.NewTimer(5 * time.Second)
			select {
			case <-done:
				graceTimer.Stop()
			case <-ctx.Done():
				graceTimer.Stop()
				_ = cmd.Process.Kill()
				select {
				case <-done:
				case <-time.After(1 * time.Second):
					waitErr = errors.New("宿主进程未在超时内退出")
				}
			case <-graceTimer.C:
				_ = cmd.Process.Kill()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					waitErr = errors.New("宿主进程未在超时内退出")
				}
			}
		}
	}
	s.mu.Lock()
	if s.active == owned {
		s.active = nil
		s.clearIdentityLocked()
	}
	return waitErr
}

func (s *supervisor) clearIdentityLocked() {
	s.endpoint = ""
	s.pipePath = ""
	s.nonce = ""
	s.proxyFingerprint = ""
	s.testOwned = false
	if s.lifetimeW != nil {
		_ = s.lifetimeW.Close()
		s.lifetimeW = nil
	}
}

func (s *supervisor) testingUseEndpoint(baseURL, nonce, fingerprint string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.testOwned = true
	s.endpoint = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	s.pipePath = ""
	s.pipeMode = false
	s.nonce = nonce
	s.fingerprint = fingerprint
	s.proxyFingerprint = ""
	s.launchedAt = time.Now()
	s.lastErr = nil
	s.active = nil
}
