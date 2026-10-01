package runtimeinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteDiscoverRemove(t *testing.T) {
	dir := t.TempDir()
	if _, found := Discover(dir); found {
		t.Fatal("没有运行时文件时不该发现地址")
	}
	if err := Write(dir, "http://127.0.0.1:53211/api", "v1.6.1"); err != nil {
		t.Fatal(err)
	}
	info, found := Discover(dir)
	if !found {
		t.Fatal("应能发现本进程写下的地址")
	}
	if info.BaseURL != "http://127.0.0.1:53211/api" || info.Version != "v1.6.1" {
		t.Fatalf("发现的内容不对：%+v", info)
	}
	if info.PID != os.Getpid() {
		t.Fatalf("PID 应为写入进程，得到 %d", info.PID)
	}
	// 只给本机用户读：里面是当前工作区的入口地址。
	stat, err := os.Stat(Path(dir))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Mode().Perm() != 0o600 {
		t.Fatalf("运行时文件权限应为 0600，得到 %v", stat.Mode().Perm())
	}
	if err := Remove(dir); err != nil {
		t.Fatal(err)
	}
	if _, found := Discover(dir); found {
		t.Fatal("退出后不该继续发现地址")
	}
	// 重复清理是幂等的。
	if err := Remove(dir); err != nil {
		t.Fatal(err)
	}
}

// 进程已经退出的文件是过期信息：绝不能拿这个端口去连别的进程。
func TestDiscoverIgnoresDeadProcess(t *testing.T) {
	dir := t.TempDir()
	stale := Info{BaseURL: "http://127.0.0.1:53211/api", PID: deadPID(t), Version: "v1.0.0"}
	encoded, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(dir), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found := Discover(dir); found {
		t.Fatal("进程已退出的运行时文件应被忽略")
	}
}

// 不属于本进程的运行时文件不能被清掉：那会把另一个还在跑的实例的地址抹掉。
func TestRemoveLeavesAnotherInstanceAlone(t *testing.T) {
	dir := t.TempDir()
	other := Info{BaseURL: "http://127.0.0.1:53212/api", PID: os.Getpid() + 1}
	encoded, _ := json.Marshal(other)
	if err := os.WriteFile(Path(dir), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Remove(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Path(dir)); err != nil {
		t.Fatal("另一个实例的运行时文件被删掉了")
	}
}

func TestDiscoverIgnoresGarbageAndEmptyBaseURL(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(Path(dir), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found := Discover(dir); found {
		t.Fatal("损坏的运行时文件应被忽略")
	}
	encoded, _ := json.Marshal(Info{PID: os.Getpid()})
	if err := os.WriteFile(Path(dir), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found := Discover(dir); found {
		t.Fatal("没有地址的运行时文件应被忽略")
	}
}

func TestDefaultDataDirHonorsOverrides(t *testing.T) {
	t.Setenv("BEEFTV_DATA_DIR", "")
	t.Setenv("CANVAS_DESKTOP_DATA_DIR", filepath.Join("tmp", "desktop-data"))
	got, err := DefaultDataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join("tmp", "desktop-data") {
		t.Fatalf("应使用桌面数据目录覆盖，得到 %q", got)
	}
	// CLI 侧的显式指定优先级更高：用来连非默认目录的工作区。
	t.Setenv("BEEFTV_DATA_DIR", filepath.Join("tmp", "cli-data"))
	got, err = DefaultDataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join("tmp", "cli-data") {
		t.Fatalf("BEEFTV_DATA_DIR 应优先，得到 %q", got)
	}
}

func TestProcessAlive(t *testing.T) {
	if !ProcessAlive(os.Getpid()) {
		t.Fatal("当前进程应判定为存活")
	}
	if ProcessAlive(0) || ProcessAlive(-1) {
		t.Fatal("非法 PID 不该判定为存活")
	}
	if ProcessAlive(deadPID(t)) {
		t.Fatal("已退出的进程不该判定为存活")
	}
}

// deadPID 给出一个远超系统 PID 上限的值，当作确定不存在的进程。
// 这和 desktopupdate 的测试用同一招，不依赖外部命令，Windows 上也成立。
func deadPID(t *testing.T) int {
	t.Helper()
	return 987654321
}
