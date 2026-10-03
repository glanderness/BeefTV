package chatgptauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var (
	errInvalidToken   = errors.New("ChatGPT 订阅令牌格式无效")
	errNotConnected   = errors.New("尚未连接 ChatGPT 订阅")
	errConnectionLost = errors.New("ChatGPT 订阅授权已失效，请重新连接")
)

func loadState(dataDir string) (persistedState, error) {
	empty := persistedState{SchemaVersion: connectionSchema, Users: map[string]persistedUser{}}
	body, err := os.ReadFile(filepath.Join(dataDir, connectionStoreFile))
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return persistedState{}, fmt.Errorf("读取 ChatGPT 订阅状态失败：%w", err)
	}
	var state persistedState
	if err := json.Unmarshal(body, &state); err != nil {
		return persistedState{}, errors.New("ChatGPT 订阅状态损坏")
	}
	if state.SchemaVersion != connectionSchema {
		return persistedState{}, errors.New("不支持的 ChatGPT 订阅状态版本")
	}
	if state.Users == nil {
		state.Users = map[string]persistedUser{}
	}
	return state, nil
}

func saveState(dataDir string, state persistedState) error {
	state.SchemaVersion = connectionSchema
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if state.Users == nil {
		state.Users = map[string]persistedUser{}
	}
	body, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("编码 ChatGPT 订阅状态失败：%w", err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("创建 ChatGPT 订阅目录失败：%w", err)
	}
	tmp, err := os.CreateTemp(dataDir, ".chatgpt-subscription-*")
	if err != nil {
		return fmt.Errorf("创建 ChatGPT 订阅临时文件失败：%w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("设置 ChatGPT 订阅文件权限失败：%w", err)
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入 ChatGPT 订阅状态失败：%w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("同步 ChatGPT 订阅状态失败：%w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭 ChatGPT 订阅状态失败：%w", err)
	}
	if err := os.Rename(tmpName, filepath.Join(dataDir, connectionStoreFile)); err != nil {
		return fmt.Errorf("替换 ChatGPT 订阅状态失败：%w", err)
	}
	if directory, err := os.Open(dataDir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func encodeUser(dataDir string, tokens tokenSet, lastRefresh time.Time) (persistedUser, error) {
	accessToken, err := encryptSecret(dataDir, tokens.AccessToken)
	if err != nil {
		return persistedUser{}, err
	}
	refreshToken, err := encryptSecret(dataDir, tokens.RefreshToken)
	if err != nil {
		return persistedUser{}, err
	}
	idToken, err := encryptSecret(dataDir, tokens.IDToken)
	if err != nil {
		return persistedUser{}, err
	}
	return persistedUser{
		AccessToken: accessToken, RefreshToken: refreshToken, IDToken: idToken,
		AccountID: tokens.AccountID, PlanType: tokens.PlanType, Email: tokens.Email,
		FedRAMP: tokens.FedRAMP, ConnectedAt: formatTime(tokens.ConnectedAt),
		LastRefresh: formatTime(lastRefresh),
	}, nil
}

func decodeUser(dataDir string, user persistedUser) (tokenSet, error) {
	accessToken, err := decryptSecret(dataDir, user.AccessToken)
	if err != nil {
		return tokenSet{}, err
	}
	refreshToken, err := decryptSecret(dataDir, user.RefreshToken)
	if err != nil {
		return tokenSet{}, err
	}
	idToken, err := decryptSecret(dataDir, user.IDToken)
	if err != nil {
		return tokenSet{}, err
	}
	return tokenSet{
		AccessToken: accessToken, RefreshToken: refreshToken, IDToken: idToken,
		AccountID: user.AccountID, PlanType: user.PlanType, Email: user.Email,
		FedRAMP: user.FedRAMP, ConnectedAt: parseTime(user.ConnectedAt),
	}, nil
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
