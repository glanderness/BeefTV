package chatgptauth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const encryptedSecretPrefix = "enc:v1:"

// encryptSecret 用工作区 `.settings-key` 保护令牌后再落盘。密钥文件与
// backend/internal/app/secret_store.go 和 beefapi 共用同一份，避免令牌在
// 本地出现第二套信任根。
func encryptSecret(dataDir, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	gcm, err := settingsCipher(dataDir)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)
	return encryptedSecretPrefix + base64.RawStdEncoding.EncodeToString(append(nonce, ciphertext...)), nil
}

func decryptSecret(dataDir, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if !strings.HasPrefix(value, encryptedSecretPrefix) {
		return "", errors.New("ChatGPT 订阅令牌密文格式无效")
	}
	payload, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(value, encryptedSecretPrefix))
	if err != nil {
		return "", errors.New("ChatGPT 订阅令牌密文格式无效")
	}
	gcm, err := settingsCipher(dataDir)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", errors.New("ChatGPT 订阅令牌密文长度无效")
	}
	plaintext, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("ChatGPT 订阅令牌解密失败")
	}
	return string(plaintext), nil
}

func settingsCipher(dataDir string) (cipher.AEAD, error) {
	key, err := settingsEncryptionKey(dataDir)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func settingsEncryptionKey(dataDir string) ([]byte, error) {
	path := filepath.Join(dataDir, ".settings-key")
	if data, err := os.ReadFile(path); err == nil && len(data) == 32 {
		return data, nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, fmt.Errorf("读取工作区密钥失败：%w", readErr)
		}
		if len(data) != 32 {
			return nil, errors.New("工作区密钥长度无效")
		}
		return data, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(key); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	return key, nil
}
