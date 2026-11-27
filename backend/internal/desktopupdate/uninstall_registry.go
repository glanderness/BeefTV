package desktopupdate

import "strings"

const windowsUninstallRegistryKeyPath = `Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV`

var syncWindowsUninstallRegistryVersion = syncWindowsUninstallDisplayVersion

type windowsUninstallRegistryOps struct {
	readInstallLocation func() (string, error)
	writeDisplayVersion func(string) error
}

func normalizeWindowsDisplayVersion(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	bare := strings.TrimPrefix(strings.TrimPrefix(trimmed, "v"), "V")
	if _, err := parseStableVersion("v" + bare); err != nil {
		return ""
	}
	return bare
}

func normalizeWindowsInstallDir(raw string) string {
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.Trim(cleaned, `"`)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return ""
	}
	cleaned = strings.ReplaceAll(cleaned, "/", `\`)
	uncPrefix := strings.HasPrefix(cleaned, `\\`)
	for strings.Contains(cleaned, `\\`) {
		cleaned = strings.ReplaceAll(cleaned, `\\`, `\`)
	}
	if uncPrefix {
		cleaned = `\` + cleaned
	}
	for len(cleaned) > 1 && strings.HasSuffix(cleaned, `\`) {
		if len(cleaned) == 3 && cleaned[1] == ':' {
			break
		}
		cleaned = strings.TrimSuffix(cleaned, `\`)
	}
	return strings.ToLower(cleaned)
}

func windowsInstallLocationMatches(registeredLocation, installDir string) bool {
	registered := normalizeWindowsInstallDir(registeredLocation)
	active := normalizeWindowsInstallDir(installDir)
	return registered != "" && active != "" && registered == active
}

func applyWindowsUninstallDisplayVersion(installDir, rawVersion string, ops windowsUninstallRegistryOps) error {
	version := normalizeWindowsDisplayVersion(rawVersion)
	if version == "" || ops.readInstallLocation == nil || ops.writeDisplayVersion == nil {
		return nil
	}
	registeredDir, err := ops.readInstallLocation()
	if err != nil {
		return err
	}
	if !windowsInstallLocationMatches(registeredDir, installDir) {
		return nil
	}
	return ops.writeDisplayVersion(version)
}
