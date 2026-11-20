//go:build !windows

package main

import (
	"context"
	"runtime"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func platformHasNativeModalDialog() bool {
	return false
}

func showCrashRecoveryDialog(ctx context.Context, repeated bool) (string, error) {
	return wailsruntime.MessageDialog(ctx, crashRecoveryDialogOptions(runtime.GOOS, repeated))
}
