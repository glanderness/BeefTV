//go:build unix

package assistantruntime

import (
	"context"
	"syscall"
	"testing"
	"time"
)

// 应用关闭必须带走「本 Host 启动的」宿主子进程，且绝不能碰无关进程。
func TestStopContextDoesNotReapOutsider(t *testing.T) {
	outsider := startOutsider(t)
	outsiderAlive := func() bool { return outsider.Process.Signal(syscall.Signal(0)) == nil }

	host := fixtureHost(t, "sleep")
	if err := host.Launch(fixtureProvider(), "http://127.0.0.1:18090/api", "desktop-shell-token"); err != nil {
		t.Fatalf("启动测试宿主失败: %v", err)
	}
	childPID := host.PID()
	if childPID == 0 || !host.Running() {
		t.Fatal("子进程应处于运行状态")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := host.StopContext(ctx); err != nil {
		t.Fatalf("关闭钩子应成功停止本 Host 启动的宿主: %v", err)
	}
	if !waitUntil(5*time.Second, func() bool { return syscall.Kill(childPID, syscall.Signal(0)) != nil }) {
		t.Fatalf("宿主子进程 %d 在关闭后仍在运行", childPID)
	}
	if !outsiderAlive() {
		t.Fatal("关闭钩子不应影响不是它启动的进程")
	}
}
