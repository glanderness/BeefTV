package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// agentHostConfig 记录当前使用的文本模型与宿主启动命令；由本机用户在设置里配置。
type agentHostConfig struct {
	Model       string `json:"model"`
	HostCommand string `json:"hostCommand"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

const agentHostConfigFile = "agent_config.json"

func readAgentHostConfig(dataDir string) (agentHostConfig, bool) {
	raw, err := os.ReadFile(filepath.Join(dataDir, agentHostConfigFile))
	if err != nil {
		return agentHostConfig{}, false
	}
	var config agentHostConfig
	if json.Unmarshal(raw, &config) != nil {
		return agentHostConfig{}, false
	}
	return config, true
}

func writeAgentHostConfig(dataDir string, config agentHostConfig) error {
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".agent-config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dataDir, agentHostConfigFile))
}

// agentHostSupervisor 只在被显式要求时启动宿主，并持有其 PID 以便停止与状态查询。
type agentHostSupervisor struct {
	mu  sync.Mutex
	cmd *exec.Cmd
}

func (s *agentHostSupervisor) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return false
	}
	return s.cmd.Process.Signal(syscall.Signal(0)) == nil
}

func (s *agentHostSupervisor) start(command string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil && s.cmd.Process.Signal(syscall.Signal(0)) == nil {
		return nil
	}
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return agentops.InvalidArg("empty_host_command", "未配置宿主启动命令")
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	s.cmd = cmd
	return nil
}

func (s *agentHostSupervisor) stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return nil
	}
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	s.cmd = nil
	return nil
}

// RegisterAgentHostLifecycleRoutes 暴露宿主配置与启停：全部需要 owner 凭据 + 本机同源。
func RegisterAgentHostLifecycleRoutes(r gin.IRouter, svc *app.Service, supervisor *agentHostSupervisor) {
	ownerGuard := func(c *gin.Context) bool {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("只接受本机同源请求"))
			return false
		}
		if !agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner"))) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("宿主启停需要 owner 凭据"))
			return false
		}
		return true
	}

	r.GET("/agent/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		config, configured := readAgentHostConfig(svc.DataDir())
		ok(c, gin.H{"config": config, "configured": configured, "supervisorRunning": supervisor.running()})
	})

	r.PUT("/agent/host/config", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		var request agentHostConfig
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		if err := writeAgentHostConfig(svc.DataDir(), request); err != nil {
			fail(c, http.StatusInternalServerError, app.BadAuthRequest("配置写入失败"))
			return
		}
		ok(c, gin.H{"config": request})
	})

	r.POST("/agent/host/start", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		config, configured := readAgentHostConfig(svc.DataDir())
		if !configured || strings.TrimSpace(config.HostCommand) == "" {
			// 命令只来自本机配置，绝不接受请求体传入的可执行命令。
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_command_missing",
				"msg": "未配置 agent-host 启动命令：请先在设置的创作助手中配置（发行形态下由产品启动链提供）"})
			return
		}
		if err := supervisor.start(config.HostCommand); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "host_start_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"started": true, "pid": strconv.Itoa(supervisorPid(supervisor))})
	})

	r.POST("/agent/host/stop", func(c *gin.Context) {
		if !ownerGuard(c) {
			return
		}
		if err := supervisor.stop(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "reason": "host_stop_failed", "msg": err.Error()})
			return
		}
		ok(c, gin.H{"stopped": true})
	})
}

func supervisorPid(s *agentHostSupervisor) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}
