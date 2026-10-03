package chatgptauth

import "time"

// 连接状态。pending 表示设备码已下发、正在等待用户在浏览器确认。
const (
	StateDisconnected = "disconnected"
	StatePending      = "pending"
	StateConnected    = "connected"
	StateExpired      = "expired"
	StateRevoked      = "revoked"
	StateError        = "error"
)

// Summary 是暴露给前端的连接摘要，永远不包含 access_token / refresh_token。
type Summary struct {
	State           string `json:"state"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`
	ExpiresAt       string `json:"expiresAt,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	PlanType        string `json:"planType,omitempty"`
	Email           string `json:"email,omitempty"`
	ConnectedAt     string `json:"connectedAt,omitempty"`
	ErrorReason     string `json:"errorReason,omitempty"`
	CredentialRef   string `json:"credentialRef,omitempty"`
	HasCredential   bool   `json:"hasCredential"`
}

// Credential 是一次模型调用需要的短期凭据。
type Credential struct {
	AccessToken string
	AccountID   string
	PlanType    string
	FedRAMP     bool
}

const connectionStoreFile = "chatgpt-subscription.json"
const connectionSchema = 1

// persistedState 是磁盘格式。令牌字段存放 `enc:v1:` 密文，其余为可展示元数据。
type persistedUser struct {
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	IDToken      string `json:"idToken,omitempty"`
	AccountID    string `json:"accountId,omitempty"`
	PlanType     string `json:"planType,omitempty"`
	Email        string `json:"email,omitempty"`
	FedRAMP      bool   `json:"fedramp,omitempty"`
	ConnectedAt  string `json:"connectedAt,omitempty"`
	LastRefresh  string `json:"lastRefresh,omitempty"`
	Revoked      bool   `json:"revoked,omitempty"`
}

type persistedState struct {
	SchemaVersion int                      `json:"schemaVersion"`
	UpdatedAt     string                   `json:"updatedAt,omitempty"`
	Users         map[string]persistedUser `json:"users"`
}

// tokenSet 是内存中的明文令牌集合。
type tokenSet struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	AccountID    string
	PlanType     string
	Email        string
	FedRAMP      bool
	ConnectedAt  time.Time
}
