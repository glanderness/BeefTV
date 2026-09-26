package desktopupdate

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GenerateTestKey returns a base64 raw 32-byte public key and the matching
// private key. Production code never calls this; it exists so a sibling worker
// can sign a local feed without embedding a repository secret.
func GenerateTestKey() (publicKeyB64 string, privateKey ed25519.PrivateKey, err error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	return base64.StdEncoding.EncodeToString(public), private, nil
}

func WriteZip(path string, files map[string][]byte, executable map[string]bool) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	writer := zip.NewWriter(file)
	for name, body := range files {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		mode := os.FileMode(0o644)
		if executable[name] {
			mode = 0o755
		}
		if strings.HasSuffix(name, "/") {
			header.Name = name
			header.SetMode(os.ModeDir | 0o755)
		} else {
			header.SetMode(mode)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			_ = writer.Close()
			return err
		}
		if _, err := entry.Write(body); err != nil {
			_ = writer.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return file.Sync()
}

func WriteDarwinLayout(root, marker string) error {
	exe := filepath.Join(root, appBundleName, "Contents", "MacOS", "BeefTV")
	plist := filepath.Join(root, appBundleName, "Contents", "Info.plist")
	plugin := filepath.Join(root, appBundleName, "Contents", "Resources", pluginDirName, "official.beeftv-plugin")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plugin), 0o755); err != nil {
		return err
	}
	script := fmt.Sprintf("#!/bin/sh\necho %s\n", marker)
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(plist, []byte(`<plist><dict><key>CFBundleIdentifier</key><string>app.beeftv.desktop</string></dict></plist>`), 0o644); err != nil {
		return err
	}
	return os.WriteFile(plugin, []byte("official-"+marker), 0o644)
}

func WriteWindowsLayout(root, marker string) error {
	exe := filepath.Join(root, windowsExeName)
	plugin := filepath.Join(root, pluginDirName, "official.beeftv-plugin")
	if err := os.MkdirAll(filepath.Dir(plugin), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(exe, []byte("MZ-"+marker), 0o644); err != nil {
		return err
	}
	return os.WriteFile(plugin, []byte("official-"+marker), 0o644)
}

func DarwinZipFiles(marker string) (map[string][]byte, map[string]bool) {
	files := map[string][]byte{
		"BeefTV.app/Contents/MacOS/BeefTV":                                     []byte("#!/bin/sh\necho " + marker + "\n"),
		"BeefTV.app/Contents/Info.plist":                                       []byte("<plist></plist>"),
		"BeefTV.app/Contents/Resources/plugin-packages/official.beeftv-plugin": []byte("official-" + marker),
	}
	execFiles := map[string]bool{"BeefTV.app/Contents/MacOS/BeefTV": true}
	return files, execFiles
}

func WindowsZipFiles(marker string) (map[string][]byte, map[string]bool) {
	files := map[string][]byte{
		"BeefTV.exe":                             []byte("MZ-" + marker),
		"plugin-packages/official.beeftv-plugin": []byte("official-" + marker),
	}
	return files, map[string]bool{}
}

func testPayload(version, platform, artifactURL, sha256 string, size int64, notes string) Payload {
	return Payload{
		Schema:  1,
		Version: version,
		Commit:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Notes:   notes,
		Platforms: map[string]PlatformArtifact{
			platform: {URL: artifactURL, SHA256: sha256, Size: size},
		},
	}
}
