//go:build windows

package workspace

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func configFileInUse(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func retryableConfigReplaceError(err error) bool {
	return configFileInUse(err) || errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, os.ErrPermission)
}
