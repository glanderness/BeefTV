//go:build !darwin && !windows

package desktopnet

func readSystemProxyRaw() (systemProxySettings, bool) { return systemProxySettings{}, true }
