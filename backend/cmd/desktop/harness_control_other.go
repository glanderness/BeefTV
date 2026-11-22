//go:build !darwin && !linux && !windows

package main

import (
	"errors"
	"net"
)

const harnessControlSupported = false

func listenHarnessControl(string, harnessRuntimeConfig) (net.Listener, error) {
	return nil, errors.New("harness control is not supported on this platform")
}

func attachDesktopHarness(string) (harnessRuntimeConfig, error) {
	return harnessRuntimeConfig{}, errors.New("harness control is not supported on this platform")
}
