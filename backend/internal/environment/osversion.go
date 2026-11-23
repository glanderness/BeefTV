package environment

import (
	"fmt"
	"strings"
)

func parseLinuxOSRelease(raw string) string {
	var id, versionID, pretty string
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, val, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		switch key {
		case "ID":
			id = val
		case "VERSION_ID":
			versionID = val
		case "PRETTY_NAME":
			pretty = val
		}
	}
	if id != "" && versionID != "" {
		return id + " " + versionID
	}
	return pretty
}

func formatWindowsOSVersion(major, minor, build uint32) string {
	if major == 0 && minor == 0 && build == 0 {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d", major, minor, build)
}
