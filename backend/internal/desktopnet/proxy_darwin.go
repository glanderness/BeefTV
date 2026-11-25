package desktopnet

import (
	"context"
	"os/exec"
	"time"
)

func readSystemProxyRaw() (systemProxySettings, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return systemProxySettings{}, false
	}
	return parseMacProxy(string(output)), true
}
