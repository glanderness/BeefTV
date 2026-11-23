//go:build windows

package environment

import "golang.org/x/sys/windows"

func osVersion() string {
	v := windows.RtlGetVersion()
	if v == nil {
		return ""
	}
	return formatWindowsOSVersion(v.MajorVersion, v.MinorVersion, v.BuildNumber)
}
