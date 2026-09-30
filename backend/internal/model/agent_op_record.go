package model

import "time"

// AgentOpRecord 持久化已执行的操作，用于操作 ID 去重：
// 同一 opId 且同一 payload 回读原结果；同一 opId 不同 payload 视为冲突。
type AgentOpRecord struct {
	UserID      string    `json:"userId" gorm:"primaryKey;size:36"`
	OpID        string    `json:"opId" gorm:"primaryKey;size:80"`
	Op          string    `json:"op" gorm:"size:80"`
	PayloadHash string    `json:"payloadHash" gorm:"size:64"`
	Status      string    `json:"status" gorm:"size:24"`
	ResultJSON  string    `json:"resultJson" gorm:"type:text"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
