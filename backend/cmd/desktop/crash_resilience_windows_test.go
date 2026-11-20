//go:build windows

package main

import (
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsCrashRecoveryMessageBoxFlagsEnableCancelAndClose(t *testing.T) {
	flags := windowsCrashRecoveryMessageBoxFlags()
	if flags&windows.MB_YESNOCANCEL != windows.MB_YESNOCANCEL {
		t.Fatalf("flags %#x must include MB_YESNOCANCEL so Cancel/Esc/X stay enabled", flags)
	}
	if flags&windows.MB_DEFBUTTON3 != windows.MB_DEFBUTTON3 {
		t.Fatalf("flags %#x must default to button 3 (Cancel / continue waiting)", flags)
	}
	if flags&windows.MB_ICONWARNING != windows.MB_ICONWARNING {
		t.Fatalf("flags %#x must include MB_ICONWARNING", flags)
	}
	if flags&windows.MB_SETFOREGROUND != windows.MB_SETFOREGROUND {
		t.Fatalf("flags %#x must include MB_SETFOREGROUND", flags)
	}
	if got := windowsMessageBoxChoice(win32IDYes); got != "Yes" {
		t.Fatalf("IDYES mapped to %q, want Yes", got)
	}
	if got := windowsMessageBoxChoice(win32IDNo); got != "No" {
		t.Fatalf("IDNO mapped to %q, want No", got)
	}
	if got := windowsMessageBoxChoice(win32IDCancel); got != "Cancel" {
		t.Fatalf("IDCANCEL mapped to %q, want Cancel", got)
	}
	if want := fmt.Sprintf("BeefTVMainWindow-%d", os.Getpid()); startupWindowClassName() != want {
		t.Fatalf("startupWindowClassName() = %q, want %q", startupWindowClassName(), want)
	}
}
