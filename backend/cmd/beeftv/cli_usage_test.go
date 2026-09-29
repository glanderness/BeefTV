package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// 二级子命令必须被校验：缺失/未知不能 panic，也不能被当成 update/create 发出去。
func TestCanvasSubcommandGuards(t *testing.T) {
	var calls int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")

	cases := [][]string{
		{"canvas", "node"},
		{"canvas", "node", "delete", "--canvas", "c1", "--node", "n1"},
		{"canvas", "nodes"},
		{"canvas", "nodes", "delete", "--canvas", "c1"},
		{"canvas", "edge"},
		{"canvas", "edge", "delete", "--canvas", "c1"},
	}
	for _, args := range cases {
		err := run(args)
		if err == nil {
			t.Fatalf("%v 应返回用法错误", args)
		}
		cliErr, ok := err.(*cliError)
		if !ok || cliErr.code != exitUsage {
			t.Fatalf("%v 应为 exitUsage，得到 %v", args, err)
		}
	}
	if calls != 0 {
		t.Fatalf("用法错误不应发出任何 HTTP 请求，实际 %d 次", calls)
	}
}

// -h/--help 属于正常退出，不是错误。
func TestHelpFlagExitsCleanly(t *testing.T) {
	if err := run([]string{"canvas", "node", "update", "--help"}); err != nil {
		t.Fatalf("--help 应正常退出，得到 %v", err)
	}
	if err := run([]string{"--help"}); err != nil {
		t.Fatalf("顶层 --help 应正常退出，得到 %v", err)
	}
	if err := run([]string{"-h"}); err != nil {
		t.Fatalf("顶层 -h 应正常退出，得到 %v", err)
	}
}
