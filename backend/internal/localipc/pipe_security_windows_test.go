//go:build windows

package localipc

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func readPipeDACLString(t *testing.T, endpoint string) string {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(
		ptr,
		windows.READ_CONTROL,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile(READ_CONTROL): %v", err)
	}
	defer windows.CloseHandle(h)

	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo: %v", err)
	}
	return sd.String()
}

func TestWindowsPipeDACLDeniesNetworkAndEveryone(t *testing.T) {
	userSID, err := currentUserSIDString()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Go-created server pipe via Listen.
	goPipe := AgentHostEndpoint()
	listener, err := Listen(goPipe)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer listener.Close()

	sddl := readPipeDACLString(t, goPipe)
	if !strings.HasPrefix(sddl, "D:P") || !strings.Contains(sddl, ";NU)") || !strings.Contains(sddl, userSID) {
		t.Fatalf("expected protected current-user + deny-network SDDL, got %q", sddl)
	}
	if strings.Contains(sddl, ";WD)") || strings.Contains(sddl, ";AN)") {
		t.Fatalf("pipe DACL must not grant Everyone (WD) or Anonymous (AN): %q", sddl)
	}

	// 2. Child-created pipe with default NULL SECURITY_ATTRIBUTES (matching libuv)
	// tightened via TightenEndpointSecurity before credentials are sent.
	libuvPipe := AgentHostEndpoint()
	namePtr, err := windows.UTF16PtrFromString(libuvPipe)
	if err != nil {
		t.Fatal(err)
	}
	rawHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.WRITE_DAC|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		windows.PIPE_UNLIMITED_INSTANCES,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe default DACL: %v", err)
	}
	defer windows.CloseHandle(rawHandle)

	if err := TightenEndpointSecurity(libuvPipe); err != nil {
		t.Fatalf("TightenEndpointSecurity: %v", err)
	}
	tightenedSDDL := readPipeDACLString(t, libuvPipe)
	if !strings.HasPrefix(tightenedSDDL, "D:P") || !strings.Contains(tightenedSDDL, ";NU)") || !strings.Contains(tightenedSDDL, userSID) {
		t.Fatalf("expected tightened protected SDDL, got %q", tightenedSDDL)
	}
	if strings.Contains(tightenedSDDL, ";WD)") || strings.Contains(tightenedSDDL, ";AN)") {
		t.Fatalf("tightened pipe DACL still grants Everyone or Anonymous: %q", tightenedSDDL)
	}

	// 3. Subsequent pipe instance created with NULL SECURITY_ATTRIBUTES (exact libuv
	// accept-loop behavior for the next request carrying credentials) must inherit
	// the tightened kernel named-pipe object DACL rather than reverting to Everyone.
	secondHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		windows.PIPE_UNLIMITED_INSTANCES,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe second instance: %v", err)
	}
	defer windows.CloseHandle(secondHandle)

	secondSD, err := windows.GetSecurityInfo(secondHandle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo(secondHandle): %v", err)
	}
	secondSDDL := secondSD.String()
	if !strings.HasPrefix(secondSDDL, "D:P") || !strings.Contains(secondSDDL, ";NU)") || !strings.Contains(secondSDDL, userSID) {
		t.Fatalf("subsequent NULL-attr pipe instance lost tightened SDDL: %q", secondSDDL)
	}
	if strings.Contains(secondSDDL, ";WD)") || strings.Contains(secondSDDL, ";AN)") {
		t.Fatalf("subsequent NULL-attr pipe instance reverted to Everyone/Anonymous: %q", secondSDDL)
	}
}

func TestDialContextBoundsWaitWhenAllPipeInstancesAreBusy(t *testing.T) {
	busyPipe := AgentHostEndpoint()
	namePtr, err := windows.UTF16PtrFromString(busyPipe)
	if err != nil {
		t.Fatal(err)
	}
	// MaxInstances=1: once connected, all instances are busy (ERROR_PIPE_BUSY).
	srvHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		1,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe(max=1): %v", err)
	}
	defer windows.CloseHandle(srvHandle)

	occupant, err := windows.CreateFile(
		namePtr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS,
		0,
	)
	if err != nil {
		t.Fatalf("occupy sole pipe instance: %v", err)
	}
	defer windows.CloseHandle(occupant)

	prevTimeout := defaultDialTimeout
	defaultDialTimeout = 120 * time.Millisecond
	defer func() { defaultDialTimeout = prevTimeout }()

	start := time.Now()
	conn, dialErr := DialContext(context.Background(), busyPipe)
	if dialErr == nil {
		_ = conn.Close()
		t.Fatal("expected busy pipe dial without caller deadline to time out")
	}
	if !errors.Is(dialErr, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", dialErr)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("expected bounded dial failure within 2s, took %v", elapsed)
	}
}
