//go:build !windows

package depthruntime

import "os/exec"

func ConfigurePythonCommand(_ *exec.Cmd) {}

func pythonFilesystemPath(path string) string { return path }

func runPythonProcess(command *exec.Cmd) error { return command.Run() }
