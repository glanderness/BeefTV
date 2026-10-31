//go:build !windows

package networkcheck

import "runtime"

func osRelease() string { return runtime.GOOS }
