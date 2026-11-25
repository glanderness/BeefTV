//go:build !windows

package workspace

import (
	"errors"
	"os"
)

func configFileInUse(error) bool { return false }

func configPermissionError(err error) bool { return errors.Is(err, os.ErrPermission) }

func retryableConfigReplaceError(error) bool { return false }
