// 地址发现与重连行为测试：桌面工作区端口随启动变化，客户端必须在 transport
// 失败后自动跟上新地址，且显式 BEEFTV_BASE_URL 不被偷偷改写。
package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/runtimeinfo"
)

// newOpsTestServer 起一个最小工作区：只回应操作清单。生命周期由调用方管理，
// 重连测试需要主动提前关闭旧实例来模拟工作区重启。
func newOpsTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ops" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[]},"msg":"ok"}`))
	}))
}

// 工作区重启换端口后，运行中的客户端在下一次操作时自动重连新地址（核心场景：
// BeefTV 重启不应导致 MCP 会话里的工具持续失败）。
func TestClientRefreshesBaseURLOnTransportFailure(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")

	serverA := newOpsTestServer(t)
	if err := runtimeinfo.Write(dataDir, serverA.URL, "v-test"); err != nil {
		t.Fatal(err)
	}
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(false); err != nil {
		t.Fatalf("初始地址应连通：%v", err)
	}

	// 模拟 BeefTV 重启：旧端口下线，运行时描述文件指向新端口。
	serverA.Close()
	serverB := newOpsTestServer(t)
	defer serverB.Close()
	if err := runtimeinfo.Write(dataDir, serverB.URL, "v-test"); err != nil {
		t.Fatal(err)
	}

	if _, err := c.listOps(false); err != nil {
		t.Fatalf("工作区换端口后应自动重连：%v", err)
	}
	if got := c.currentBaseURL(); got != serverB.URL {
		t.Fatalf("应切换到新地址 %s，得到 %q", serverB.URL, got)
	}
}

// MCP 工具 handler 是并发调用的：换地址瞬间的并发请求要全部重连成功，
// 且 -race 下不出现数据竞争。
func TestClientRefreshIsConcurrencySafe(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")

	serverA := newOpsTestServer(t)
	if err := runtimeinfo.Write(dataDir, serverA.URL, "v-test"); err != nil {
		t.Fatal(err)
	}
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(false); err != nil {
		t.Fatalf("初始地址应连通：%v", err)
	}

	serverA.Close()
	serverB := newOpsTestServer(t)
	defer serverB.Close()
	if err := runtimeinfo.Write(dataDir, serverB.URL, "v-test"); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	failures := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.listOps(false); err != nil {
				failures <- err
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatalf("并发重连应全部成功：%v", err)
	}
}

// 显式 BEEFTV_BASE_URL 是调用方钉死的配置：即使运行时描述文件指向可用工作区，
// 也不自动切换，失败原样返回。
func TestExplicitBaseURLNotRefreshed(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()

	dead := newOpsTestServer(t)
	deadURL := dead.URL
	dead.Close()
	alive := newOpsTestServer(t)
	defer alive.Close()
	if err := runtimeinfo.Write(dataDir, alive.URL, "v-test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_BASE_URL", deadURL)
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(false); err == nil {
		t.Fatal("显式地址不可达时应失败")
	} else if cliErr, ok := err.(*cliError); !ok || cliErr.reason != "transport_failed" {
		t.Fatalf("应原样返回 transport_failed，得到 %v", err)
	}
	if got := c.currentBaseURL(); got != deadURL {
		t.Fatalf("显式 BEEFTV_BASE_URL 不应被自动切换，得到 %q", got)
	}
}

// 没有任何工作区时：构造成功（--help 离线可用），操作返回 runtime_not_found，
// 且不会因为重发现路径缺 http.Client 之类的问题崩溃。
func TestRefreshKeepsErrorWithoutRuntimeFile(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if c.currentBaseURL() != "" {
		t.Fatalf("没有任何工作区时不应有地址，得到 %q", c.currentBaseURL())
	}
	_, err = c.listOps(false)
	if cliErr, ok := err.(*cliError); !ok || cliErr.reason != "runtime_not_found" {
		t.Fatalf("无运行时文件应保持 runtime_not_found，得到 %v", err)
	}
	if _, source := c.baseURLInfo(); source != baseSourceMissing {
		t.Fatalf("诊断应如实说明未发现工作区，得到 %q", source)
	}
}

// 客户端先于工作区构造：工作区上线后，下一次操作自动恢复，无需重建客户端。
func TestClientRecoversWhenWorkspaceAppearsLater(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	dataDir := t.TempDir()
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	t.Setenv("BEEFTV_OWNER_TOKEN", "")
	t.Setenv("BEEFTV_DESKTOP_TOKEN", "")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(false); err == nil {
		t.Fatal("工作区未上线时应失败")
	}

	server := newOpsTestServer(t)
	defer server.Close()
	if err := runtimeinfo.Write(dataDir, server.URL, "v-test"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.listOps(false); err != nil {
		t.Fatalf("工作区上线后应自动恢复：%v", err)
	}
}
