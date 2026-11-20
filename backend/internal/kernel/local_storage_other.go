//go:build !windows

package kernel

import (
	"errors"
	"syscall"
)

func isDiskFullErrno(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}
