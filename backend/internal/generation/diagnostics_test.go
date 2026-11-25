package generation

import (
	"strings"
	"testing"
)

func TestDiagnosticSummaryHidesMountedAndNetworkPaths(t *testing.T) {
	for _, path := range []string{`/Volumes/PrivateDrive/customer-A/image.png`, `/Volumes/External Work/customer-A/image.png`, `C:\Private User\customer-A\image.png`, `\\Private Server\Private Share\customer-A\image.png`, `/mnt/PrivateDrive/customer-A/image.png`, `/media/PrivateDrive/customer-A/image.png`, `/app/uploads/Private-customer-A/image.png`, `/data/uploads/Private-customer-A/image.png`, `/workspace/Private-customer-A/image.png`, `\\PrivateServer\PrivateShare\customer-A\image.png`} {
		got := DiagnosticSummary("open " + path + ": permission denied")
		if strings.Contains(got, "Private") || strings.Contains(got, "customer-A") || !strings.Contains(got, "permission denied") {
			t.Fatalf("unsafe summary %q", got)
		}
	}
}

func TestDiagnosticSummaryDoesNotMangleHTTPURLsAsLocalPaths(t *testing.T) {
	for _, msg := range []string{
		`本次请求准备失败：Get "https://beeftv.app/v1/models": EOF`,
		`Post "https://beeftv.app/v1/media/tasks": connection reset by peer`,
		`Put "https://storage.example.com/media/uploads/part1?X-Amz-Signature=secret": unexpected EOF`,
	} {
		got := DiagnosticSummary(msg)
		if strings.Contains(got, "[路径已隐藏]") || strings.Contains(got, "http[") || strings.Contains(got, "beeftv.app") || strings.Contains(got, "secret") {
			t.Fatalf("HTTP URL mangled as local path or leaked: %q -> %q", msg, got)
		}
		if !strings.Contains(got, "EOF") && !strings.Contains(got, "connection reset by peer") {
			t.Fatalf("transport cause lost: %q -> %q", msg, got)
		}
		if strings.Contains(got, `Get "`) || strings.Contains(got, `Post "`) || strings.Contains(got, `Put "`) {
			t.Fatalf("HTTP verb quote artifact leaked: %q -> %q", msg, got)
		}
	}
	if got := DiagnosticSummary(`Put " context deadline exceeded`); got != "context deadline exceeded" {
		t.Fatalf("dangling quote not cleaned: %q", got)
	}
	combined := DiagnosticSummary(`cannot read C:\Users\PRIVATE\image.png https://host/file?token=PRIVATE Authorization: Bearer PRIVATE multi word`)
	if strings.Contains(combined, "PRIVATE") || !strings.Contains(combined, "[路径已隐藏]") {
		t.Fatalf("combined path+url+credential summary leaked: %q", combined)
	}
	if got := RedactLocalPaths(`/home/a:/private/b`, "[路径已隐藏]"); got != "[路径已隐藏]:[路径已隐藏]" {
		t.Fatalf("mixed unix paths = %q", got)
	}
	if got := RedactLocalPaths(`C:\\A_.B`, "[路径已隐藏]"); got != "[路径已隐藏]" {
		t.Fatalf("escaped windows path = %q", got)
	}
}

func TestRedactLocalPathsHTTPMethodPrefixBoundaries(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		want      string
		wantLocal bool
	}{
		{
			name:      "simple GET safe route preserved",
			input:     "GET /workspace/bootstrap",
			want:      "GET /workspace/bootstrap",
			wantLocal: false,
		},
		{
			name:      "many spaces between method and safe route preserved",
			input:     "GET" + strings.Repeat(" ", 20) + "/workspace/bootstrap",
			want:      "GET" + strings.Repeat(" ", 20) + "/workspace/bootstrap",
			wantLocal: false,
		},
		{
			name:      "tab separator preserved",
			input:     "POST\t/workspace/model-config",
			want:      "POST\t/workspace/model-config",
			wantLocal: false,
		},
		{
			name:      "quote and paren boundaries with lowercase method preserved",
			input:     `("patch /workspace/model-config/capability")`,
			want:      `("patch /workspace/model-config/capability")`,
			wantLocal: false,
		},
		{
			name:      "bracket boundary preserved",
			input:     "[OPTIONS /workspace/bootstrap]",
			want:      "[OPTIONS /workspace/bootstrap]",
			wantLocal: false,
		},
		{
			name:      "newline boundary preserved",
			input:     "request:\nDELETE /workspace/bootstrap",
			want:      "request:\nDELETE /workspace/bootstrap",
			wantLocal: false,
		},
		{
			name:      "prefixed non-boundary method redacted",
			input:     "aGET /workspace/bootstrap",
			want:      "aGET [路径已隐藏]",
			wantLocal: true,
		},
		{
			name:      "prefixed non-boundary method with many spaces redacted",
			input:     "aGET" + strings.Repeat(" ", 12) + "/workspace/bootstrap",
			want:      "aGET" + strings.Repeat(" ", 12) + "[路径已隐藏]",
			wantLocal: true,
		},
		{
			name:      "newline instead of horizontal whitespace redacted",
			input:     "GET\n/workspace/bootstrap",
			want:      "GET\n[路径已隐藏]",
			wantLocal: true,
		},
		{
			name:      "colon separator instead of horizontal whitespace redacted",
			input:     "GET:/workspace/bootstrap",
			want:      "GET:[路径已隐藏]",
			wantLocal: true,
		},
		{
			name:      "alphanumeric prefix before slash ignored as non-root segment",
			input:     "GET/workspace/bootstrap",
			want:      "GET/workspace/bootstrap",
			wantLocal: false,
		},
		{
			name:      "non-HTTP verb before safe route path redacted",
			input:     "open /workspace/bootstrap: permission denied",
			want:      "open [路径已隐藏]: permission denied",
			wantLocal: true,
		},
		{
			name:      "HTTP method before non-allowlisted workspace file redacted",
			input:     "GET /workspace/secret/key.json",
			want:      "GET [路径已隐藏]",
			wantLocal: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RedactLocalPaths(tc.input, "[路径已隐藏]"); got != tc.want {
				t.Fatalf("RedactLocalPaths(%q) = %q, want %q", tc.input, got, tc.want)
			}
			if got := HasLocalPath(tc.input); got != tc.wantLocal {
				t.Fatalf("HasLocalPath(%q) = %v, want %v", tc.input, got, tc.wantLocal)
			}
		})
	}
}
