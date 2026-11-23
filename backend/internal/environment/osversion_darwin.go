//go:build darwin

package environment

import (
	"strings"

	"golang.org/x/sys/unix"
)

func osVersion() string {
	version, err := unix.Sysctl("kern.osproductversion")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(version)
}
