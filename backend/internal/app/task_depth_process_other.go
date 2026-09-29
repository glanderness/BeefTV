//go:build !windows

package app

import "os/exec"

func configureDepthCommand(_ *exec.Cmd) {}
