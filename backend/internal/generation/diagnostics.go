package generation

import (
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

// PathError separates the path and cause with a colon; spaces are legal in paths.
// Without a reliable delimiter, conservatively hide the remaining suffix too.
var diagnosticLocalPathScan = regexp.MustCompile(`(?i)(file://[^\r\n"'<>]+)|([a-z]:[\\/][^\r\n:"'<>]+)|(\\\\[^\r\n:"'<>]+)|(/+(?:Users|home|private|tmp|var|Volumes|mnt|media|run|root|opt|srv|etc|data|app|workspace|usr|proc|sys|dev|lib|bin|sbin)/[^\r\n:"'<>]+)`)
var httpMethodPrefix = regexp.MustCompile(`(?i)(?:^|[ \t\r\n"'(\[])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[ \t]+$`)
var safeAppAPIRoute = regexp.MustCompile(`(?i)^/workspace/(?:bootstrap|model-config(?:/capability)?)(?:$|\s|[）),;\]])`)
var diagnosticTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$`)

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isUnixPathPrefixBlocked(b byte) bool {
	return isASCIILetter(b) || (b >= '0' && b <= '9') || b == '.' || b == '_' || b == '-'
}

func isValidLocalPathMatch(value string, loc []int) bool {
	start, end := loc[0], loc[1]
	if loc[4] >= 0 {
		return start == 0 || !isASCIILetter(value[start-1])
	}
	if loc[8] >= 0 {
		if start > 0 && isUnixPathPrefixBlocked(value[start-1]) {
			return false
		}
		if safeAppAPIRoute.MatchString(value[start:end]) && httpMethodPrefix.MatchString(value[:start]) {
			return false
		}
	}
	return true
}

// HasLocalPath reports whether value contains a local filesystem, UNC, or file:// path.
func HasLocalPath(value string) bool {
	for scanFrom := 0; scanFrom < len(value); {
		loc := diagnosticLocalPathScan.FindStringSubmatchIndex(value[scanFrom:])
		if loc == nil {
			return false
		}
		for i := range loc {
			if loc[i] >= 0 {
				loc[i] += scanFrom
			}
		}
		if isValidLocalPathMatch(value, loc) {
			return true
		}
		scanFrom = loc[0] + 1
	}
	return false
}

// RedactLocalPaths scrubs file://, Windows drive, UNC, and Unix local paths
// in a single left-to-right pass while preserving HTTP(S) URLs and safe app API routes.
func RedactLocalPaths(value, replacement string) string {
	if value == "" {
		return value
	}
	var out strings.Builder
	cursor := 0
	for scanFrom := 0; scanFrom < len(value); {
		loc := diagnosticLocalPathScan.FindStringSubmatchIndex(value[scanFrom:])
		if loc == nil {
			break
		}
		for i := range loc {
			if loc[i] >= 0 {
				loc[i] += scanFrom
			}
		}
		if isValidLocalPathMatch(value, loc) {
			out.WriteString(value[cursor:loc[0]])
			out.WriteString(replacement)
			cursor = loc[1]
			scanFrom = loc[1]
		} else {
			scanFrom = loc[0] + 1
		}
	}
	if cursor == 0 {
		return value
	}
	out.WriteString(value[cursor:])
	return out.String()
}

func diagnosticToken(value string) string {
	if !diagnosticTokenPattern.MatchString(value) || unsafeIDPattern.MatchString(value) || HasLocalPath(value) || strings.Contains(value, "://") {
		return ""
	}
	return value
}

// DiagnosticSummary preserves the error message without copying payloads or local paths.
func DiagnosticSummary(message string) string {
	if strings.HasPrefix(strings.TrimSpace(message), "[") {
		return ""
	}
	return sanitizeProviderText(message)
}

func SanitizeTaskDiagnostics(input *model.TaskFailureDiagnostics) *model.TaskFailureDiagnostics {
	if input == nil {
		return nil
	}
	d := *input
	d.Version = diagnosticToken(d.Version)
	d.Platform = diagnosticToken(d.Platform)
	if d.ExecutionResult != "completed" && d.ExecutionResult != "failed" && d.ExecutionResult != "pending" {
		d.ExecutionResult = ""
	}
	d.Requests = append([]model.TaskRequestEvidence(nil), input.Requests...)
	if len(d.Requests) > 8 {
		d.OmittedRequests += len(d.Requests) - 8
		d.Requests = d.Requests[len(d.Requests)-8:]
	}
	for i := range d.Requests {
		r := &d.Requests[i]
		r.Operation = diagnosticEnum(r.Operation, "image_edit", "image_generate", "query_or_download", "submit", "reference_create", "reference_put", "reference_complete", "reference_resume", "reference_abort", "other")
		r.Method = diagnosticEnum(r.Method, "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")
		r.TransportPhase = diagnosticEnum(r.TransportPhase, "dns", "connect", "tls", "request", "response_wait", "response")
		if r.Attempt < 0 || r.Attempt > 4 {
			r.Attempt = 0
		}
		r.TransportRoute = diagnosticEnum(r.TransportRoute, "direct", "proxy")
		r.Outcome = diagnosticEnum(r.Outcome, "response_received", "transport_error", "not_dispatched", "http_error", "cancelled", "timeout", "business_error", "response_limit")
		r.RequestID, r.ProviderCode, r.Summary = sanitizeDebugID(r.RequestID), sanitizeProviderCode(r.ProviderCode), DiagnosticSummary(r.Summary)
		if r.HTTPStatus < 100 || r.HTTPStatus > 599 {
			r.HTTPStatus = 0
		}
		if _, err := time.Parse(time.RFC3339Nano, r.StartedAt); err != nil {
			r.StartedAt = ""
		}
	}
	if input.Input != nil {
		v := *input.Input
		v.Protocol, v.Model, v.Size, v.Quality, v.Count = diagnosticToken(v.Protocol), diagnosticToken(v.Model), diagnosticToken(v.Size), diagnosticToken(v.Quality), diagnosticToken(v.Count)
		v.Images = append([]model.TaskDiagnosticMedia(nil), v.Images...)
		if len(v.Images) > 16 {
			v.Images = v.Images[:16]
		}
		d.Input = &v
	}
	switch d.Source {
	case "local_validation", "local_network", "upstream_http", "upstream_response", "local_result", "local_response", "reference_upload":
	default:
		d.Source = "unknown"
	}
	d.Summary = DiagnosticSummary(d.Summary)
	d.Stage = DiagnosticSummary(d.Stage)
	if d.FailedOperation != "" {
		d.FailedOperation = diagnosticEnum(d.FailedOperation, "reference_create", "reference_put", "reference_complete", "reference_resume", "reference_abort")
	}
	if d.TransportPhase != "" {
		d.TransportPhase = diagnosticEnum(d.TransportPhase, "dns", "connect", "tls", "request", "response_wait", "response")
	}
	d.ProviderCode = sanitizeProviderCode(d.ProviderCode)
	if d.Source != "upstream_http" && d.Source != "upstream_response" && d.Source != "reference_upload" {
		d.ProviderCode = ""
	}
	d.RequestID = sanitizeDebugID(d.RequestID)
	d.ProviderTaskID = sanitizeDebugID(d.ProviderTaskID)
	d.Param = sanitizeProviderCode(d.Param)
	if d.HTTPStatus < 100 || d.HTTPStatus > 599 {
		d.HTTPStatus = 0
	}
	if _, err := time.Parse(time.RFC3339Nano, d.CapturedAt); err != nil {
		d.CapturedAt = ""
	}
	return &d
}

func diagnosticEnum(value string, allowed ...string) string {
	for _, item := range allowed {
		if value == item {
			return value
		}
	}
	return "unknown"
}
