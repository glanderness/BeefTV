//go:build !darwin && !windows && !linux

package environment

func osVersion() string {
	return ""
}
