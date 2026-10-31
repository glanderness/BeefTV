package depthruntime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPythonPipUsesExtendedPathsWithoutSystemPolicyChanges(t *testing.T) {
	for input, want := range map[string]string{
		`C:\用户\runtime`:          `\\?\C:\用户\runtime`,
		`\\server\share\runtime`: `\\?\UNC\server\share\runtime`,
		`\\?\C:\runtime`:         `\\?\C:\runtime`,
	} {
		if got := pythonFilesystemPath(input); got != want {
			t.Fatalf("extended Python path %q = %q, want %q", input, got, want)
		}
	}
}

func TestInstallerJobStopsItsChildOnHardHostExit(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	parent := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestInstallerJobParentFixture$")
	parent.Env = append(os.Environ(), "BEEFTV_WHEEL_JOB_HELPER=parent", "BEEFTV_WHEEL_JOB_PID="+pidPath)
	ConfigurePythonCommand(parent)
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { parent.Process.Kill(); parent.Wait() }()
	var pid int
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if raw, err := os.ReadFile(pidPath); err == nil {
			pid, _ = strconv.Atoi(string(raw))
			if pid > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid <= 0 {
		t.Fatal("owned child did not start")
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(child)
	defer windows.TerminateProcess(child, 1)
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	status, err := windows.WaitForSingleObject(child, 5000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("child survived hard parent exit: status=%d err=%v", status, err)
	}
}

func TestInstallerJobParentFixture(t *testing.T) {
	if os.Getenv("BEEFTV_WHEEL_JOB_HELPER") != "parent" {
		return
	}
	child := exec.CommandContext(context.Background(), os.Args[0], "-test.run=^TestInstallerJobChildFixture$")
	child.Env = append(os.Environ(), "BEEFTV_WHEEL_JOB_HELPER=child")
	ConfigurePythonCommand(child)
	if err := runPythonProcess(child); err != nil {
		t.Fatal(err)
	}
}

func TestInstallerJobChildFixture(t *testing.T) {
	if os.Getenv("BEEFTV_WHEEL_JOB_HELPER") != "child" {
		return
	}
	if err := os.WriteFile(os.Getenv("BEEFTV_WHEEL_JOB_PID"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Second)
}
