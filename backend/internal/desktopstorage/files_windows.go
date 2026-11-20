//go:build windows

package desktopstorage

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func fileInUse(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

func retryableReplaceError(err error) bool {
	return fileInUse(err) || errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, os.ErrPermission)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	err = directory.Sync()
	var pathErr *os.PathError
	if errors.As(err, &pathErr) && pathErr.Op == "sync" && errors.Is(pathErr.Err, windows.ERROR_ACCESS_DENIED) {
		return nil
	}
	return err
}
