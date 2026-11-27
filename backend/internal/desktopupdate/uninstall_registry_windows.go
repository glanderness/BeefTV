//go:build windows

package desktopupdate

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

func syncWindowsUninstallDisplayVersion(installDir, rawVersion string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, windowsUninstallRegistryKeyPath, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	defer key.Close()
	return applyWindowsUninstallDisplayVersion(installDir, rawVersion, windowsUninstallRegistryOps{
		readInstallLocation: func() (string, error) {
			value, _, err := key.GetStringValue("InstallLocation")
			if errors.Is(err, registry.ErrNotExist) {
				return "", nil
			}
			return value, err
		},
		writeDisplayVersion: func(version string) error {
			return key.SetStringValue("DisplayVersion", version)
		},
	})
}
