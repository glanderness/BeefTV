//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	isCrashWindowVisible    = startupWindowUser32.NewProc("IsWindowVisible")
	isCrashWindowEnabled    = startupWindowUser32.NewProc("IsWindowEnabled")
	getCrashLastActivePopup = startupWindowUser32.NewProc("GetLastActivePopup")
	getCrashWindowClassName = startupWindowUser32.NewProc("GetClassNameW")
)

const (
	mbYesNoCancel   = 0x00000003 // MB_YESNOCANCEL (enables Cancel button, Esc, and titlebar close X)
	mbIconWarning   = 0x00000030 // MB_ICONWARNING
	mbDefButton3    = 0x00000200 // MB_DEFBUTTON3 (default to Cancel / continue waiting)
	mbSetForeground = 0x00010000 // MB_SETFOREGROUND
)

func findBeefTVMainWindow() uintptr {
	className, err := windows.UTF16PtrFromString(fmt.Sprintf("BeefTVMainWindow-%d", os.Getpid()))
	if err != nil {
		return 0
	}
	hwnd, _, _ := findStartupWindow.Call(uintptr(unsafe.Pointer(className)), 0)
	return hwnd
}

// platformHasNativeModalDialog reports whether a native Win32 modal dialog
// (such as a WebView2 <input type="file"> picker, common folder/save dialog,
// or system message box) is currently open on top of BeefTV's main window.
// WebView2 suspends renderer JS timers during modal Win32 dialogs, so the
// watchdog must pause while a modal dialog owns the UI loop.
func platformHasNativeModalDialog() bool {
	hwnd := findBeefTVMainWindow()
	if hwnd == 0 {
		return false
	}
	visible, _, _ := isCrashWindowVisible.Call(hwnd)
	if visible == 0 {
		return false
	}
	if enabled, _, _ := isCrashWindowEnabled.Call(hwnd); enabled == 0 {
		return true
	}
	popup, _, _ := getCrashLastActivePopup.Call(hwnd)
	if popup == 0 || popup == hwnd {
		return false
	}
	if popupVisible, _, _ := isCrashWindowVisible.Call(popup); popupVisible == 0 {
		return false
	}
	var classBuf [64]uint16
	n, _, _ := getCrashWindowClassName.Call(popup, uintptr(unsafe.Pointer(&classBuf[0])), uintptr(len(classBuf)))
	return n > 0 && windows.UTF16ToString(classBuf[:n]) == "#32770"
}

func showCrashRecoveryDialog(_ context.Context, repeated bool) (string, error) {
	opts := crashRecoveryDialogOptions("windows", repeated)
	title, err := windows.UTF16PtrFromString(opts.Title)
	if err != nil {
		return "", err
	}
	message, err := windows.UTF16PtrFromString(opts.Message)
	if err != nil {
		return "", err
	}
	var owner uintptr
	if hwnd := findBeefTVMainWindow(); hwnd != 0 {
		if visible, _, _ := isCrashWindowVisible.Call(hwnd); visible != 0 {
			owner = hwnd
		}
	}
	flags := uintptr(mbYesNoCancel | mbIconWarning | mbDefButton3 | mbSetForeground)
	button, _, _ := showStartupMessageBox.Call(owner, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), flags)
	if button == 0 {
		return "", fmt.Errorf("显示无响应恢复弹窗失败")
	}
	return windowsMessageBoxChoice(uint32(button)), nil
}
