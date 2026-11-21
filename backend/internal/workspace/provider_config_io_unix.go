//go:build !windows

package workspace

func configFileInUse(error) bool { return false }

func retryableConfigReplaceError(error) bool { return false }
