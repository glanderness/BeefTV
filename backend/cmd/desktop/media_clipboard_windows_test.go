//go:build windows

package main

import (
	"context"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsMediaClipboardCommandHidesConsoleWindow(t *testing.T) {
	cmd, err := buildClipboardWriteCommand(context.Background(), "windows", `C:\temp\clip.mp4`)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("expected hidden Windows clipboard subprocess, got SysProcAttr=%+v", cmd.SysProcAttr)
	}
}
