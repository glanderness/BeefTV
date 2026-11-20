//go:build windows

package main

import (
	"context"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	isCrashWindowVisible    = startupWindowUser32.NewProc("IsWindowVisible")
	isCrashWindowEnabled    = startupWindowUser32.NewProc("IsWindowEnabled")
	enumCrashWindows        = startupWindowUser32.NewProc("EnumWindows")
	getCrashWindowOwner     = startupWindowUser32.NewProc("GetWindow")
	getCrashWindowAncestor  = startupWindowUser32.NewProc("GetAncestor")
	getCrashWindowPID       = startupWindowUser32.NewProc("GetWindowThreadProcessId")
	getCrashWindowClassName = startupWindowUser32.NewProc("GetClassNameW")

	// Allocate the Win32 EnumWindows callback exactly once (syscall.NewCallback
	// thunks are permanent per process) and guard the scan state with a mutex.
	modalEnumMu       sync.Mutex
	modalEnumMainHwnd uintptr
	modalEnumSelfPID  uint32
	modalEnumFound    bool
	modalEnumCallback = syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if hwnd == 0 || hwnd == modalEnumMainHwnd {
			return 1
		}
		if visible, _, _ := isCrashWindowVisible.Call(hwnd); visible == 0 {
			return 1
		}
		if !isDialogWindowClass(hwnd) {
			return 1
		}
		var pid uint32
		_, _, _ = getCrashWindowPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == modalEnumSelfPID {
			modalEnumFound = true
			return 0
		}
		if owner, _, _ := getCrashWindowOwner.Call(hwnd, gwOwner); owner != 0 {
			if owner == modalEnumMainHwnd {
				modalEnumFound = true
				return 0
			}
			if root, _, _ := getCrashWindowAncestor.Call(owner, gaRoot); root == modalEnumMainHwnd {
				modalEnumFound = true
				return 0
			}
		}
		return 1
	})
)

const (
	gwOwner = 4 // GW_OWNER
	gaRoot  = 2 // GA_ROOT
)

func findBeefTVMainWindow() uintptr {
	className, err := windows.UTF16PtrFromString(startupWindowClassName())
	if err != nil {
		return 0
	}
	hwnd, _, _ := findStartupWindow.Call(uintptr(unsafe.Pointer(className)), 0)
	return hwnd
}

func windowsCrashRecoveryMessageBoxFlags() uint32 {
	// MB_YESNOCANCEL keeps Cancel, Esc, and the titlebar X close button enabled
	// so users can safely continue waiting; MB_DEFBUTTON3 makes Cancel default.
	return windows.MB_YESNOCANCEL | windows.MB_ICONWARNING | windows.MB_DEFBUTTON3 | windows.MB_SETFOREGROUND
}

func isDialogWindowClass(hwnd uintptr) bool {
	var classBuf [64]uint16
	n, _, _ := getCrashWindowClassName.Call(hwnd, uintptr(unsafe.Pointer(&classBuf[0])), uintptr(len(classBuf)))
	return n > 0 && windows.UTF16ToString(classBuf[:n]) == "#32770"
}

// platformHasNativeModalDialog reports whether a native Win32 modal dialog
// (such as a WebView2 <input type="file"> picker, common folder/save dialog,
// or system message box) is currently active on top of BeefTV's main window.
// WebView2 suspends renderer JS timers while a Win32 modal dialog runs, so the
// watchdog pauses until the dialog closes.
func platformHasNativeModalDialog() bool {
	mainHwnd := findBeefTVMainWindow()
	if mainHwnd == 0 {
		return false
	}
	if visible, _, _ := isCrashWindowVisible.Call(mainHwnd); visible == 0 {
		return false
	}
	if enabled, _, _ := isCrashWindowEnabled.Call(mainHwnd); enabled == 0 {
		return true
	}
	// Fallback for WebView2 file pickers owned by a child Chrome_WidgetWin_*
	// HWND or hosted on a separate WebView2 helper process: look for any visible
	// Win32 system dialog (#32770) belonging to this process or owned by mainHwnd.
	modalEnumMu.Lock()
	defer modalEnumMu.Unlock()
	modalEnumMainHwnd = mainHwnd
	modalEnumSelfPID = uint32(os.Getpid())
	modalEnumFound = false
	_, _, _ = enumCrashWindows.Call(modalEnumCallback, 0)
	return modalEnumFound
}

func showCrashRecoveryDialog(_ context.Context, repeated bool) (string, error) {
	titleText, messageText := crashRecoveryDialogText("windows", repeated)
	title, err := windows.UTF16PtrFromString(titleText)
	if err != nil {
		return "", err
	}
	message, err := windows.UTF16PtrFromString(messageText)
	if err != nil {
		return "", err
	}
	var owner windows.HWND
	if hwnd := findBeefTVMainWindow(); hwnd != 0 {
		if visible, _, _ := isCrashWindowVisible.Call(hwnd); visible != 0 {
			owner = windows.HWND(hwnd)
		}
	}
	button, err := windows.MessageBox(owner, message, title, windowsCrashRecoveryMessageBoxFlags())
	if err != nil {
		return "", err
	}
	return windowsMessageBoxChoice(button), nil
}
