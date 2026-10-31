package depthcapture

import (
	"os/exec"

	"infinite-canvas/backend/internal/depthruntime"
)

func configureDepthCommand(command *exec.Cmd) {
	depthruntime.ConfigurePythonCommand(command)
}
