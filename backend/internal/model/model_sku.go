package model

import (
	"encoding/json"
	"strings"
)

func DecodeSKUSelector(raw string) map[string]string {
	selector := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return selector
	}
	_ = json.Unmarshal([]byte(raw), &selector)
	return selector
}
