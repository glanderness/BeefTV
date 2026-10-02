package depthcapture

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func configureDepthCommand(command *exec.Cmd) {
	command.WaitDelay = 5 * time.Second
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		killCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(killCtx, "taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid)).Run()
		return command.Process.Kill()
	}
}
