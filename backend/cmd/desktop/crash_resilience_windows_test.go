//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"testing"
	"unsafe"

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

func TestWindowsPlatformHasNativeModalDialogDetectsDisabledMainAndSystemDialog(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	registerClassEx := startupWindowUser32.NewProc("RegisterClassExW")
	unregisterClass := startupWindowUser32.NewProc("UnregisterClassW")
	createWindowEx := startupWindowUser32.NewProc("CreateWindowExW")
	showWindow := startupWindowUser32.NewProc("ShowWindow")
	destroyWindow := startupWindowUser32.NewProc("DestroyWindow")
	enableWindow := startupWindowUser32.NewProc("EnableWindow")
	defWindowProc := startupWindowUser32.NewProc("DefWindowProcW")
	getModuleHandle := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")

	type wndClassExW struct {
		cbSize        uint32
		style         uint32
		lpfnWndProc   uintptr
		cbClsExtra    int32
		cbWndExtra    int32
		hInstance     uintptr
		hIcon         uintptr
		hCursor       uintptr
		hbrBackground uintptr
		lpszMenuName  *uint16
		lpszClassName *uint16
		hIconSm       uintptr
	}

	hInst, _, _ := getModuleHandle.Call(0)
	classNamePtr, err := windows.UTF16PtrFromString(startupWindowClassName())
	if err != nil {
		t.Fatal(err)
	}
	wndProc := syscall.NewCallback(func(hwnd, msg, wParam, lParam uintptr) uintptr {
		ret, _, _ := defWindowProc.Call(hwnd, msg, wParam, lParam)
		return ret
	})
	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   wndProc,
		hInstance:     hInst,
		lpszClassName: classNamePtr,
	}
	if atom, _, regErr := registerClassEx.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		t.Fatalf("RegisterClassExW failed: %v", regErr)
	}
	defer unregisterClass.Call(uintptr(unsafe.Pointer(classNamePtr)), hInst)

	const (
		wsVisible          = 0x10000000
		wsPopup            = 0x80000000
		wsOverlappedWindow = 0x00CF0000
		swShowNoActivate   = 4
	)
	titlePtr, _ := windows.UTF16PtrFromString("BeefTV Test Main")
	mainHwnd, _, createErr := createWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(classNamePtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		wsOverlappedWindow|wsVisible,
		0, 0, 200, 150,
		0, 0, hInst, 0,
	)
	if mainHwnd == 0 {
		t.Fatalf("CreateWindowExW main window failed: %v", createErr)
	}
	defer destroyWindow.Call(mainHwnd)
	// On Windows the first ShowWindow call honors STARTUPINFO.wShowWindow (which
	// headless SSH/CI runners may set to SW_HIDE); calling twice ensures WS_VISIBLE.
	_, _, _ = showWindow.Call(mainHwnd, swShowNoActivate)
	_, _, _ = showWindow.Call(mainHwnd, swShowNoActivate)

	// 1. Visible, enabled main window with no modal dialog -> false.
	if platformHasNativeModalDialog() {
		t.Fatal("expected platformHasNativeModalDialog()=false when main window is enabled and no dialog exists")
	}

	// 2. Main window disabled by a modal loop (IFileOpenDialog / SaveFileDialog / MessageBox) -> true.
	_, _, _ = enableWindow.Call(mainHwnd, 0)
	if !platformHasNativeModalDialog() {
		found := findBeefTVMainWindow()
		vis, _, _ := isCrashWindowVisible.Call(mainHwnd)
		en, _, _ := isCrashWindowEnabled.Call(mainHwnd)
		t.Fatalf("expected platformHasNativeModalDialog()=true when main window is disabled (mainHwnd=%#x found=%#x vis=%d en=%d)", mainHwnd, found, vis, en)
	}
	_, _, _ = enableWindow.Call(mainHwnd, 1)
	if platformHasNativeModalDialog() {
		t.Fatal("expected platformHasNativeModalDialog()=false after re-enabling main window")
	}

	// 3. Enabled main window + visible #32770 system dialog owned by main window -> true.
	dlgClassPtr, _ := windows.UTF16PtrFromString("#32770")
	dlgTitlePtr, _ := windows.UTF16PtrFromString("Test Picker")
	dlgHwnd, _, dlgErr := createWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(dlgClassPtr)),
		uintptr(unsafe.Pointer(dlgTitlePtr)),
		wsPopup|wsVisible,
		0, 0, 120, 80,
		mainHwnd, 0, hInst, 0,
	)
	if dlgHwnd == 0 {
		t.Fatalf("CreateWindowExW #32770 dialog failed: %v", dlgErr)
	}
	_, _, _ = showWindow.Call(dlgHwnd, swShowNoActivate)
	if !platformHasNativeModalDialog() {
		_, _, _ = destroyWindow.Call(dlgHwnd)
		t.Fatal("expected platformHasNativeModalDialog()=true while visible #32770 dialog exists")
	}
	if !isWindowOwnedByMain(dlgHwnd, mainHwnd) {
		_, _, _ = destroyWindow.Call(dlgHwnd)
		t.Fatal("expected isWindowOwnedByMain()=true for owned #32770 dialog")
	}

	// 4. Multi-hop ownership: #32770 dialog owned by an intermediate top-level popup owned by mainHwnd.
	nestedDlgHwnd, _, nestedErr := createWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(dlgClassPtr)),
		uintptr(unsafe.Pointer(dlgTitlePtr)),
		wsPopup|wsVisible,
		0, 0, 100, 60,
		dlgHwnd, 0, hInst, 0,
	)
	if nestedDlgHwnd == 0 {
		_, _, _ = destroyWindow.Call(dlgHwnd)
		t.Fatalf("CreateWindowExW nested #32770 dialog failed: %v", nestedErr)
	}
	if !isWindowOwnedByMain(nestedDlgHwnd, mainHwnd) {
		_, _, _ = destroyWindow.Call(nestedDlgHwnd)
		_, _, _ = destroyWindow.Call(dlgHwnd)
		t.Fatal("expected isWindowOwnedByMain()=true for 2-hop owned #32770 dialog")
	}
	_, _, _ = destroyWindow.Call(nestedDlgHwnd)
	_, _, _ = destroyWindow.Call(dlgHwnd)

	// 5. After #32770 dialogs close -> false again.
	if platformHasNativeModalDialog() {
		t.Fatal("expected platformHasNativeModalDialog()=false after #32770 dialogs are destroyed")
	}
}
