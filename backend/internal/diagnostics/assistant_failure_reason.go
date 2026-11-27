package diagnostics

import "strings"

// AssistantFailureReasonCodes is the fixed machine-code allowlist shared by
// the SQL projection and export sanitizer. Never return raw error messages.
func AssistantFailureReasonCodes() []string {
	return []string{
		"turn_authorization_unavailable",
		"skill_context_unavailable", "skill_context_service_unavailable",
		"skill_context_model_unavailable", "skill_context_budget_exceeded",
		"skill_context_identity_mismatch", "skill_context_changed",
		"skill_context_pin_unavailable", "skill_context_revision_conflict",
		"partial_output_stream_interrupted",
		"stream_ended_without_finish_reason",
		"model_content_filtered",
		"model_output_truncated",
		"stream_idle_timeout",
		"upstream_eof_before_first_byte",
		"provider_rate_limited",
		"provider_unavailable",
		"provider_quota_exhausted",
		"model_network_error",
	}
}

func sanitizeAssistantFailureReason(value string) string {
	for _, code := range AssistantFailureReasonCodes() {
		if value == code {
			return code
		}
	}
	return ""
}

// AllowedRawStopReasonInputs is the exact allowlist of known provider stop
// reason strings checked inside SQLite so arbitrary text never crosses the
// query boundary.
func AllowedRawStopReasonInputs() []string {
	return []string{
		"stop", "end", "end_turn", "completed", "stop_sequence", "pause_turn", "STOP",
		"length", "max_tokens", "max_output_tokens", "incomplete.max_output_tokens", "MAX_TOKENS",
		"toolUse", "tool_use", "tool_calls", "function_call",
		"error", "failed", "network_error",
		"aborted", "cancelled", "canceled",
		"content_filter", "incomplete.content_filter",
		"SAFETY", "safety", "PROHIBITED_CONTENT", "prohibited_content",
		"BLOCKLIST", "blocklist", "SPII", "spii", "RECITATION", "recitation",
		"IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "refusal", "sensitive",
	}
}

// SanitizeRawStopReason maps known provider stop reasons onto the closed safe
// diagnostic enum: stop | length | toolUse | error | aborted | content_filter.
func SanitizeRawStopReason(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "stop", "end", "end_turn", "completed", "stop_sequence", "pause_turn":
		return "stop"
	case "length", "max_tokens", "max_output_tokens", "incomplete.max_output_tokens":
		return "length"
	case "tooluse", "tool_use", "tool_calls", "function_call":
		return "toolUse"
	case "error", "failed", "network_error":
		return "error"
	case "aborted", "cancelled", "canceled":
		return "aborted"
	case "content_filter", "incomplete.content_filter", "safety", "prohibited_content",
		"blocklist", "spii", "recitation", "image_safety", "image_prohibited_content",
		"refusal", "sensitive":
		return "content_filter"
	default:
		return ""
	}
}
