package aihubkit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/localcrypto"
)

type account struct {
	mu      sync.RWMutex
	client  *client
	user    User
	token   string
	groups  map[string]Group
	keys    map[string]string
	dir     string
	service *app.Service
	models  []CatalogModel
}

func accountScope(origin string, id int) string {
	sum := sha256.Sum256([]byte(origin + "\x00" + strconv.Itoa(id)))
	return hex.EncodeToString(sum[:])
}

func (a *account) prepare(ctx context.Context) error {
	if err := a.client.call(ctx, "GET", "/api/user/self/groups", nil, a.token, a.user.ID, &a.groups); err != nil {
		return err
	}
	if _, ok := a.groups[a.user.Group]; !ok {
		return errors.New("账号默认分组不可用")
	}
	a.keys = map[string]string{}
	b, err := os.ReadFile(filepath.Join(a.dir, "aihubkit-keys.enc"))
	if err == nil {
		plain, err := localcrypto.Decrypt(a.dir, string(b))
		if err != nil {
			return errors.New("无法解密账号模型凭据")
		}
		if json.Unmarshal([]byte(plain), &a.keys) != nil {
			return errors.New("账号模型凭据格式无效")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := a.ensureKey(ctx, a.user.Group); err != nil {
		return err
	}
	_, key, _, _ := a.resolve(credentialPrefix + a.user.Group)
	return a.client.call(ctx, "GET", "/v1/models", nil, key, 0, &a.models)
}

func (a *account) ensureKey(ctx context.Context, group string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.groups[group]; !ok {
		return errors.New("账号无权使用该分组")
	}
	if a.keys[group] != "" {
		return nil
	}
	var created struct {
		Key string `json:"key"`
	}
	if err := a.client.call(ctx, "POST", "/api/token/", map[string]any{"name": "BeefTV " + group, "group": group, "unlimited_quota": true}, a.token, a.user.ID, &created); err != nil {
		return err
	}
	if created.Key == "" {
		return errors.New("未取得模型推理凭据")
	}
	key := created.Key
	if !strings.HasPrefix(key, "sk-") {
		key = "sk-" + key
	}
	keys := make(map[string]string, len(a.keys)+1)
	for group, key := range a.keys {
		keys[group] = key
	}
	keys[group] = key
	if err := os.MkdirAll(a.dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(keys)
	if err != nil {
		return err
	}
	enc, err := localcrypto.Encrypt(a.dir, string(b))
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(a.dir, ".aihubkit-keys-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(enc); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), filepath.Join(a.dir, "aihubkit-keys.enc")); err != nil {
		return err
	}
	a.keys = keys
	return nil
}

func (a *account) resolve(ref string) (string, string, bool, error) {
	if !strings.HasPrefix(ref, credentialPrefix) {
		return "", "", false, nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	group := strings.TrimPrefix(ref, credentialPrefix)
	key := a.keys[group]
	if _, ok := a.groups[group]; !ok || key == "" {
		return "", "", true, errors.New("aihubkit 分组凭据不可用，请重新登录或同步该分组")
	}
	return a.client.origin, key, true, nil
}

func (a *account) configure(s *app.Service) error {
	a.service = s
	s.SetExtensions(app.Extensions{ResolveCredential: a.resolve, ReferenceStorage: a.referenceStorage})
	return a.seedModels()
}

func (a *account) referenceStorage(config generation.Config) generation.ReferenceStoragePort {
	if strings.HasPrefix(config.CredentialRef, credentialPrefix) || sameOrigin(config.BaseURL, a.client.origin) {
		return &accountStorage{account: a}
	}
	return nil
}

func sameOrigin(raw, expected string) bool {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target.Scheme == "" || target.Host == "" || target.User != nil {
		return false
	}
	origin, err := url.Parse(expected)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.User != nil {
		return false
	}
	return strings.EqualFold(target.Scheme, origin.Scheme) && strings.EqualFold(target.Host, origin.Host)
}

type accountStorage struct {
	account   *account
	expiresAt time.Time
}

func (s *accountStorage) Enabled() (bool, error) { return s.account.token != "", nil }
func (s *accountStorage) Upload(ctx context.Context, userID, resourceID string) (string, error) {
	resource, body, err := s.account.service.OpenResource(userID, resourceID)
	if err != nil {
		return "", errors.New("参考文件不存在或不属于当前工作区")
	}
	defer body.Close()
	link, deadline, err := s.account.client.upload(ctx, s.account.token, filepath.Base(resource.ObjectKey), resource.MimeType, resource.Size, body)
	if err == nil && (s.expiresAt.IsZero() || deadline.Before(s.expiresAt)) {
		s.expiresAt = deadline
	}
	return link, err
}

// One instance belongs to one hydration batch. A slow later upload must not
// submit an already-expired earlier reference to a paid generation request.
func (s *accountStorage) ValidateReferences(context.Context) error {
	if !s.expiresAt.IsZero() && time.Until(s.expiresAt) < 30*time.Second {
		return errors.New("参考文件链接即将过期，请重新提交生成")
	}
	return nil
}
