package handler

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 宿主把 BEEFTV_OPS_URL 当基址再拼 /ops，因此这里必须带 /api 前缀；
// 少了它宿主启动即因 404 退出，界面只会显示「创作助手暂时不可用」。
func TestHostEnvOpsURLKeepsAPIPrefix(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "agent_host_token"), []byte("host-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent_owner_token"), []byte("owner-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CANVAS_BACKEND_ADDR", "127.0.0.1:18090")
	t.Setenv("CANVAS_BACKEND_PORT", "")

	env := hostEnv(dataDir, "gpt-5.5", "https://beefapi.com/v1")
	value := func(key string) string {
		prefix := key + "="
		for _, entry := range env {
			if strings.HasPrefix(entry, prefix) {
				return strings.TrimPrefix(entry, prefix)
			}
		}
		return ""
	}

	if got := value("BEEFTV_OPS_URL"); got != "http://127.0.0.1:18090/api" {
		t.Fatalf("BEEFTV_OPS_URL = %q", got)
	}
	if got := value("BEEFTV_AGENT_HOST_TOKEN"); got != "host-token" {
		t.Fatalf("BEEFTV_AGENT_HOST_TOKEN = %q", got)
	}
	if got := value("BEEFTV_OWNER_TOKEN"); got != "owner-token" {
		t.Fatalf("BEEFTV_OWNER_TOKEN = %q", got)
	}
	if got := value("BEEFTV_AGENT_DATA_DIR"); got != dataDir {
		t.Fatalf("BEEFTV_AGENT_DATA_DIR = %q", got)
	}
}
