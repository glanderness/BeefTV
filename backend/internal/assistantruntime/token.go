package assistantruntime

import (
	"os"
	"path/filepath"
	"strings"
)

const hostTokenFile = "agent_host_token"

// ReadHostToken 取值顺序与 handler / agentops 一致：显式环境变量优先，其次数据目录文件。
func ReadHostToken(dataDir string) string {
	if value := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_HOST_TOKEN")); value != "" {
		return value
	}
	return readTokenFile(dataDir, hostTokenFile)
}

func readTokenFile(dataDir, name string) string {
	if strings.TrimSpace(dataDir) == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
