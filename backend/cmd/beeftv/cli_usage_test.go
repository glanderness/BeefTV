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

// 非法 flag / 非法取值必须是可读的用法错误：flagError 曾经递归调用自己，
// 会把栈打爆而不是给出错误；同时绝不能在解析失败后还发出写入请求。
func TestInvalidFlagsAreUsageErrorsWithoutWrites(t *testing.T) {
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
		{"canvas", "node", "update", "--canvas", "c1", "--node", "n1", "--expected-revision", "1", "--op-id", "op-1", "--nope", "x"},
		{"canvas", "node", "update", "--canvas", "c1", "--node", "n1", "--expected-revision", "not-a-number", "--op-id", "op-1", "--prompt", "p"},
		{"canvas", "nodes", "create", "--canvas", "c1", "--expected-revision", "abc", "--op-id", "op-2", "--node", "标题:image"},
		{"canvas", "edge", "create", "--canvas", "c1", "--from", "a", "--to", "b", "--expected-revision", "1.5", "--op-id", "op-3"},
	}
	for _, args := range cases {
		err := run(args)
		if err == nil {
			t.Fatalf("%v 应返回用法错误", args)
		}
		cliErr, ok := err.(*cliError)
		if !ok {
			t.Fatalf("%v 应为 *cliError，得到 %T(%v)", args, err, err)
		}
		if cliErr.code != exitUsage {
			t.Fatalf("%v 应为 exitUsage，得到 %d", args, cliErr.code)
		}
		if cliErr.reason != "bad_flags" {
			t.Fatalf("%v 的 reason 应为 bad_flags，得到 %q", args, cliErr.reason)
		}
	}
	if calls != 0 {
		t.Fatalf("flag 解析失败不应发出任何 HTTP 请求，实际 %d 次", calls)
	}
}

// --read-only 必须是本地收紧，而不是把权限判断外包给服务端查询参数：
// 即使服务端返回了写操作，只读模式也不能把它们交给 MCP 或调用方。
func TestReadOnlyTightensOperationSetLocally(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 故意返回完整集合（含写操作），模拟服务端未按身份收紧的情况。
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[
			{"id":"canvas.get","summary":"读画布","readOnly":true,"scope":"canvas"},
			{"id":"canvas.node.update","summary":"改节点","readOnly":false,"scope":"canvas"},
			{"id":"canvas.nodes.create","summary":"建节点","readOnly":false,"scope":"canvas"},
			{"id":"asset.list","summary":"列素材","readOnly":true,"scope":"workspace_read"}
		]},"msg":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	t.Setenv("BEEFTV_OWNER_TOKEN", "owner-token-for-test")

	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	all, err := c.listOps(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("非只读模式应拿到全部操作，实际 %d", len(all))
	}
	tightened, err := c.listOps(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(tightened) != 2 {
		t.Fatalf("只读模式应只保留只读操作，实际 %d", len(tightened))
	}
	for _, op := range tightened {
		if !op.ReadOnly {
			t.Fatalf("只读模式仍暴露写操作 %s", op.ID)
		}
	}
}
