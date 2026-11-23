//go:build linux

package environment

import "os"

func osVersion() string {
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	return parseLinuxOSRelease(string(raw))
}
