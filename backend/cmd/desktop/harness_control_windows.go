//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"infinite-canvas/backend/internal/localipc"
)

const harnessControlSupported = true

func currentWindowsUserSID() (string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return "", errors.New("unable to resolve current Windows user SID")
	}
	return user.User.Sid.String(), nil
}

func harnessPipeEndpoint(dataDir string) (string, error) {
	canonical, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(canonical); err == nil {
		canonical = resolved
	}
	sid, err := currentWindowsUserSID()
	if err != nil {
		return "", err
	}
	// Include current user SID so different Windows users never collide on a shared path.
	digest := sha256.Sum256([]byte(sid + "\x00" + strings.ToLower(filepath.Clean(canonical))))
	return `\\.\pipe\beeftv-harness-` + hex.EncodeToString(digest[:16]), nil
}

func listenHarnessControl(dataDir string, config harnessRuntimeConfig) (net.Listener, error) {
	endpoint, err := harnessPipeEndpoint(dataDir)
	if err != nil {
		return nil, err
	}
	listener, err := localipc.Listen(endpoint)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				_ = json.NewEncoder(conn).Encode(config)
			}()
		}
	}()
	return listener, nil
}

func attachDesktopHarness(dataDir string) (harnessRuntimeConfig, error) {
	endpoint, err := harnessPipeEndpoint(dataDir)
	if err != nil {
		return harnessRuntimeConfig{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	conn, err := localipc.DialContext(ctx, endpoint)
	if err != nil {
		return harnessRuntimeConfig{}, err
	}
	defer conn.Close()
	if err := localipc.VerifyCurrentUserPipeOwner(conn); err != nil {
		return harnessRuntimeConfig{}, err
	}
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return harnessRuntimeConfig{}, err
	}
	var config harnessRuntimeConfig
	if err := json.NewDecoder(io.LimitReader(conn, 64*1024)).Decode(&config); err != nil {
		return harnessRuntimeConfig{}, err
	}
	if config.BaseURL == "" || config.LaunchToken == "" || config.BridgeURL == "" || config.BridgeToken == "" {
		return harnessRuntimeConfig{}, errors.New("harness control returned an incomplete configuration")
	}
	config.Owned = false
	config.Attached = true
	return config, nil
}
