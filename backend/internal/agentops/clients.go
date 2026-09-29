package agentops

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ClientMode 是服务端授予客户端的能力模式。客户端只能出示身份，不能自己声明模式。
type ClientMode string

const (
	ClientReadWrite ClientMode = "read-write"
	ClientReadOnly  ClientMode = "read-only"
)

// ClientRegistration 记录一个被本机用户登记过的非交互客户端。
type ClientRegistration struct {
	ID        string     `json:"id"`
	Label     string     `json:"label"`
	Mode      ClientMode `json:"mode"`
	TokenHash string     `json:"tokenHash"`
	CreatedAt time.Time  `json:"createdAt"`
}

// ClientRegistry 把登记信息持久化在数据目录里（0600），由本机用户维护。
type ClientRegistry struct {
	mu   sync.Mutex
	path string
}

func NewClientRegistry(dataDir string) *ClientRegistry {
	return &ClientRegistry{path: filepath.Join(dataDir, "agent_clients.json")}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *ClientRegistry) load() ([]ClientRegistration, error) {
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var items []ClientRegistration
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// Register 生成一次性展示的 token，并在服务端保存其哈希与模式。
func (r *ClientRegistry) Register(label string, mode ClientMode) (ClientRegistration, string, error) {
	if mode != ClientReadOnly && mode != ClientReadWrite {
		return ClientRegistration{}, "", InvalidArg("invalid_mode", "mode 必须是 read-only 或 read-write")
	}
	if strings.TrimSpace(label) == "" {
		label = "client"
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	idBuf := make([]byte, 8)
	if _, err := rand.Read(idBuf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	token := hex.EncodeToString(buf)
	reg := ClientRegistration{ID: "client-" + hex.EncodeToString(idBuf), Label: label, Mode: mode,
		TokenHash: hashToken(token), CreatedAt: time.Now().UTC()}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	items = append(items, reg)
	encoded, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	if err := atomicWriteFile(r.path, encoded); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	return reg, token, nil
}

// Lookup 按 (clientID, token) 解析身份；返回的是服务端登记的模式。
func (r *ClientRegistry) Lookup(clientID, token string) (ClientRegistration, bool) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(token) == "" {
		return ClientRegistration{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, false
	}
	want := hashToken(token)
	for _, item := range items {
		if item.ID == clientID && item.TokenHash == want {
			return item, true
		}
	}
	return ClientRegistration{}, false
}

// List 返回登记信息（不含 token 本身）。
func (r *ClientRegistry) List() []ClientRegistration {
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return nil
	}
	return items
}


// atomicWriteFile 先写临时文件再改名，避免并发登记时留下半截文件丢记录。
func atomicWriteFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-clients-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// OwnerTokenPath 是后端与可信本机前端共享的 owner 凭据；只有它能执行写操作与登记客户端。
func OwnerTokenPath(dataDir string) string { return filepath.Join(dataDir, "agent_owner_token") }

// EnsureOwnerToken 读取已有 owner token，不存在则生成（0600）。
func EnsureOwnerToken(dataDir string) (string, error) {
	path := OwnerTokenPath(dataDir)
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	if err := atomicWriteFile(path, []byte(token)); err != nil {
		return "", err
	}
	return token, nil
}

// OwnerTokenMatches 用常量时间比较 owner 凭据。
func OwnerTokenMatches(dataDir, presented string) bool {
	expected, err := EnsureOwnerToken(dataDir)
	if err != nil || presented == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}
