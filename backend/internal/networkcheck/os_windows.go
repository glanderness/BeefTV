package networkcheck

import (
	"fmt"
	"golang.org/x/sys/windows"
)

func osRelease() string {
	v := windows.RtlGetVersion()
	return fmt.Sprintf("Windows %d.%d build %d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
}
