package generation

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/protocol"
)

func TestMultipartPreparationCannotBeAnUncertainPaidSubmission(t *testing.T) {
	_, _, err := ExecuteProtocolBinaryRequest(context.Background(), Config{}, protocol.RequestSpec{Method: "POST", Path: "/videos", ContentType: "multipart/form-data", Files: []protocol.RequestFilePart{{Name: "input_reference", Reference: protocol.MediaReference{DataURL: "data:image/png;base64,invalid"}}}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) {
		t.Fatalf("expected pre-dispatch preparation error: %v", err)
	}
	classified := ClassifyError(UncertainVideoSubmission(context.Background(), err))
	if classified.Uncertain || classified.Category == CategorySubmissionUncertain {
		t.Fatalf("unsent POST classified as paid uncertainty: %#v", classified)
	}
}

func TestManagedDiscoveryTransportFailureClassifiesAsRequestNotSent(t *testing.T) {
	for _, cause := range []error{
		io.EOF,
		&url.Error{Op: "Get", URL: "https://beeftv.app/v1/models", Err: x509.UnknownAuthorityError{}},
		&net.DNSError{Err: "no such host", Name: "beeftv.app"},
	} {
		err := RequestPreparationError{Cause: beeftv.MediaDiscoveryTransportError{Cause: cause}}
		var preparation RequestPreparationError
		if !errors.As(err, &preparation) || !beeftv.IsDiscoveryTransportError(err) || !SafeRouteRejection(err) {
			t.Fatalf("expected unsent preparation error for %T: %#v", cause, err)
		}
		classified := ClassifyError(UncertainVideoSubmission(context.Background(), err))
		if classified.Uncertain || classified.Category != CategoryRequestNotSent || classified.BlocksAutomaticRetry() {
			t.Fatalf("discovery transport error %T misclassified: %#v", cause, classified)
		}
	}
}

func TestRequestPreparationErrorUsesTypedSafeCopyContract(t *testing.T) {
	cases := []struct {
		name           string
		cause          error
		wantCategory   FailureCategory
		wantContain    string
		wantNotContain string
	}{
		{
			name:           "typed invalid params with action",
			cause:          PreparationUserError{Category: CategoryInvalidParams, Reason: "超分视频须为不超过 5 分钟的 MP4 或 MOV", Action: "请裁剪时长或转码为 MP4/MOV 后重试"},
			wantCategory:   CategoryInvalidParams,
			wantContain:    "超分视频须为不超过 5 分钟的 MP4 或 MOV",
			wantNotContain: "本次请求在准备时失败",
		},
		{
			name:           "typed size limit keeps technical english cause hidden",
			cause:          PreparationUserError{Category: CategoryInputTooLarge, Reason: "超分素材超过 200MB 大小限制", Action: "请压缩或裁剪后重试", Cause: errors.New("bytes=250000000 limit=209715200")},
			wantCategory:   CategoryInputTooLarge,
			wantContain:    "超分素材超过 200MB 大小限制",
			wantNotContain: "250000000",
		},
		{
			name:           "local media open missing file",
			cause:          localMediaOpenError(fmt.Errorf("open /Users/alice/secret.mp4: %w", os.ErrNotExist)),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本地素材文件不存在或已被移除",
			wantNotContain: "/Users/alice/secret.mp4",
		},
		{
			name:           "real asset ResourceFileMissing AppError is preserved",
			cause:          fmt.Errorf("读取任务参考资源失败：%w", asset.ResourceFileMissing()),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本地媒体文件不存在或已丢失",
			wantNotContain: "本次请求在准备时失败",
		},
		{
			name:           "authored AppError message takes precedence over media sentinel",
			cause:          kernel.WrapAppError(400, "视频文件损坏或编码格式不受支持，请重新导出 MP4 后重试", mediatools.ErrInvalidMedia),
			wantCategory:   CategoryInvalidParams,
			wantContain:    "视频文件损坏或编码格式不受支持",
			wantNotContain: "无法检查媒体文件",
		},
		{
			name:           "missing ffprobe or ffmpeg sentinel",
			cause:          fmt.Errorf("%w：视频处理工具不可用，请重新安装应用", mediatools.ErrToolUnavailable),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "视频处理工具不可用",
			wantNotContain: "media tool unavailable",
		},
		{
			name:           "invalid media sentinel",
			cause:          fmt.Errorf("%w：无法检查媒体", mediatools.ErrInvalidMedia),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "无法检查媒体文件",
			wantNotContain: "invalid or unsupported media",
		},
		{
			name:           "untyped os.ErrNotExist stays generic instead of claiming missing media",
			cause:          fmt.Errorf("open /tmp/config.json: %w", os.ErrNotExist),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "本地素材文件",
		},
		{
			name:           "untyped internal Chinese message stays generic",
			cause:          errors.New("读取任务参考资源失败：资源端口未接入"),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "资源端口未接入",
		},
		{
			name:           "wrapped english db error falls back cleanly",
			cause:          fmt.Errorf("参考视频 1：%w", fmt.Errorf("读取任务参考资源失败：%w", errors.New("record not found"))),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "record not found",
		},
		{
			name:           "timeout falls back cleanly",
			cause:          context.DeadlineExceeded,
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "deadline",
		},
		{
			name:           "401 AppError maps to auth",
			cause:          kernel.Unauthorized("官方算力登录状态已过期，请重新连接"),
			wantCategory:   CategoryAuth,
			wantContain:    "官方算力登录状态已过期",
			wantNotContain: "本次请求在准备时失败",
		},
		{
			name:           "413 AppError maps to input_too_large",
			cause:          kernel.NewAppError(413, "文件体积超过允许上限"),
			wantCategory:   CategoryInputTooLarge,
			wantContain:    "文件体积超过允许上限",
			wantNotContain: "本次请求在准备时失败",
		},
		{
			name:           "500 AppError stays generic and does not leak internal detail",
			cause:          kernel.NewAppError(500, "internal sqlite migration failure"),
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "internal sqlite migration failure",
		},
		{
			name:           "raw http error inside preparation stays generic",
			cause:          HTTPError{StatusCode: 500, Body: "internal server error"},
			wantCategory:   CategoryInputInaccessible,
			wantContain:    "本次请求在准备时失败",
			wantNotContain: "internal server error",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			classified := ClassifyError(RequestPreparationError{Cause: tc.cause})
			if classified.Uncertain || classified.Retryable || classified.Category != tc.wantCategory {
				t.Fatalf("unexpected preparation classification: %#v (want category %q)", classified, tc.wantCategory)
			}
			msg := classified.UserMessage()
			if !strings.Contains(msg, tc.wantContain) {
				t.Fatalf("UserMessage() = %q, want substring %q", msg, tc.wantContain)
			}
			if tc.wantNotContain != "" && strings.Contains(msg, tc.wantNotContain) {
				t.Fatalf("UserMessage() = %q, must not contain %q", msg, tc.wantNotContain)
			}
		})
	}
}
