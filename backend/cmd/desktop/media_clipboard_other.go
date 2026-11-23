//go:build !windows

package main

import "os/exec"

func hideMediaClipboardCommandWindow(*exec.Cmd) {}
