//go:build !windows

package desktopupdate

func syncWindowsUninstallDisplayVersion(installDir, rawVersion string) error {
	return applyWindowsUninstallDisplayVersion(installDir, rawVersion, windowsUninstallRegistryOps{})
}
