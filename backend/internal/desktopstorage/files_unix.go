//go:build !windows

package desktopstorage

import "os"

func fileInUse(err error) bool { return false }

func retryableReplaceError(err error) bool { return false }

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
