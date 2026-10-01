package assistantruntime

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// supervisor 持有宿主子进程的 PID 以便停止与状态查询，
// 并记下启动时生效的供应商指纹：配置变了就需要在空闲时重启，否则宿主会一直用旧模型。
type supervisor struct {
	mu          sync.Mutex
	cmd         *exec.Cmd
	done        chan struct{}
	fingerprint string
	launchedAt  time.Time
	lastErr     error
}

// State 是状态查询需要的宿主进程事实（不含任何凭据）。
type State struct {
	Running     bool
	Fingerprint string
	LaunchedAt  time.Time
	LastError   error
}

func (s *supervisor) state() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	running := s.cmd != nil && s.cmd.Process != nil
	if running {
		select {
		case <-s.done:
			running = false
		default:
		}
	}
	return State{Running: running, Fingerprint: s.fingerprint, LaunchedAt: s.launchedAt, LastError: s.lastErr}
}

func (s *supervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return false
	}
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

func (s *supervisor) pid() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
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

func (s *supervisor) start(config HostConfig, env []string, fingerprint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		select {
		case <-s.done:
		default:
			return nil
		}
	}
	parts, err := commandParts(config)
	if err != nil {
		return err
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Env = env
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		s.lastErr = err
		return err
	}
	s.cmd = cmd
	s.done = make(chan struct{})
	s.fingerprint = fingerprint
	s.launchedAt = time.Now()
	s.lastErr = nil
	done := s.done
	// 每个子进程只 Wait 一次：stop 与崩溃回收共用这一条 goroutine。
	go func() { _ = cmd.Wait(); close(done) }()
	return nil
}

// Serialize stop/start and let the sole Wait goroutine confirm exit on every platform.
func (s *supervisor) stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmd := s.cmd
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
	} else {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	done := s.done
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			return errors.New("宿主进程未在超时内退出")
		}
	}
	s.cmd = nil
	s.done = nil
	return nil
}
