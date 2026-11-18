package model

import "time"

// MCPCall stores only display facts and references to the task runs it submitted.
type MCPCall struct {
	QuotaPerYuan int64        `json:"-"`
	ID           int64        `json:"id" gorm:"primaryKey"`
	UserID       string       `json:"-" gorm:"index:idx_mcp_recent,priority:1"`
	CreatedAt    time.Time    `json:"at" gorm:"index:idx_mcp_recent,priority:2"`
	Client       string       `json:"client"`
	Tool         string       `json:"tool"`
	Failed       bool         `json:"failed,omitempty"`
	Billing      string       `json:"billing"`
	ModelName    string       `json:"model,omitempty"`
	Tasks        []MCPTaskRun `json:"-" gorm:"serializer:json"`
	AmountCNY    *float64     `json:"amountCny,omitempty" gorm:"-"`
}

type MCPTaskRun struct {
	ID  string
	Run int
}
