package generation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

var testReferencePreparationCopies = map[string]struct{ reason, action string }{
	"image_reference_upload_failed": {"参考图片上传失败，" + unsentPreparationMarker, "请稍后重试"},
	"reference_media_upload_failed": {"参考素材上传失败，" + unsentPreparationMarker, "请检查对象存储配置和公开读取权限后重试"},
	"reference_preupload_failed":    {"参考素材上传失败，" + unsentPreparationMarker, "请检查网络或稍后重试"},
	"reference_upload_failed":       {"参考素材上传失败，" + unsentPreparationMarker, "请检查对象存储配置和公开读取权限后重试"},
}

func TestReferencePreparationSavedCodeSeparatesManualAndAutomaticRetry(t *testing.T) {
	if !strings.Contains(categoryCopies[CategoryReferenceUploadFailed].Reason, unsentPreparationMarker) {
		t.Fatalf("CategoryReferenceUploadFailed copy missing unsent marker %q: %+v", unsentPreparationMarker, categoryCopies[CategoryReferenceUploadFailed])
	}
	for code, copy := range testReferencePreparationCopies {
		original := Failure{Category: CategoryReferenceUploadFailed, ProviderCode: code, Reason: copy.reason, Action: copy.action, RequestID: "request-123456", TaskID: "task-123456"}
		for _, text := range []string{original.UserMessage(), copy.reason + "。" + copy.action + "。"} {
			restored := PersistedFailure(text, string(CategoryReferenceUploadFailed))
			if restored.Category != CategoryReferenceUploadFailed || restored.Uncertain || restored.Retryable || !restored.BlocksAutomaticRetry() || restored.BlocksManualRetry() {
				t.Fatalf("saved preparation code was not restored: %+v", restored)
			}
			if PersistedFailureBlocksRetry(text, "任务失败", string(CategoryReferenceUploadFailed)) {
				t.Fatalf("saved preparation code unexpectedly blocked manual retry: %q", text)
			}
			if !PersistedFailureBlocksRetry(text, "submission_unknown", string(CategoryReferenceUploadFailed)) {
				t.Fatalf("submission_unknown failed to override saved preparation code: %q", text)
			}
		}
		for _, text := range []string{copy.reason, "参考图片上传失败", copy.reason + "。请重新生成。", original.UserMessage() + " extra"} {
			if !ClassifyText(text).BlocksManualRetry() {
				t.Fatalf("unproved text granted manual retry: %q", text)
			}
		}
	}
}

func TestUpstreamCannotAttestPreparationByEchoingSavedCopy(t *testing.T) {
	for code, copy := range testReferencePreparationCopies {
		message := (Failure{Category: CategoryReferenceUploadFailed, ProviderCode: code, Reason: copy.reason, Action: copy.action}).UserMessage()
		for _, err := range []error{errors.New(message), PayloadError{message: message}, PayloadError{raw: fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, message)}, PayloadError{raw: fmt.Sprintf(`{"error":{"code":%q,"message":"fake upstream failure"}}`, code)}} {
			failure := ClassifyError(UncertainVideoSubmission(context.Background(), err))
			if !failure.Uncertain || !failure.BlocksManualRetry() {
				t.Fatalf("untyped echoed copy granted retry: %+v", failure)
			}
		}
		for _, body := range []string{message, fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, message), fmt.Sprintf(`{"error":{"code":%q,"message":"fake upstream failure"}}`, code)} {
			for _, status := range []int{400, 403, 503} {
				err := UncertainVideoSubmission(context.Background(), HTTPError{StatusCode: status, Body: body})
				failure := ClassifyError(err)
				if !failure.Uncertain || !failure.BlocksAutomaticRetry() || !failure.BlocksManualRetry() {
					t.Fatalf("HTTP %d echoed copy granted retry: %+v", status, failure)
				}
			}
		}
	}
}

func TestEarlierUnknownDominatesLaterPreparation(t *testing.T) {
	for _, cause := range []error{RequestPreparationError{Cause: HTTPError{StatusCode: 503, Body: `{"error":{"code":"image_reference_upload_failed"}}`}}, RequestNotSentError{Cause: context.DeadlineExceeded}, context.Canceled, HTTPError{StatusCode: 403}} {
		err := SubmissionUnknownError{Cause: cause}
		failure := ClassifyError(err)
		if !failure.Uncertain || !failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() {
			t.Fatalf("unknown was cleared by a nested unsent error: %+v", failure)
		}
		if SafeRouteRejection(err) {
			t.Fatalf("unknown was allowed to start another route: %v", err)
		}
	}
}

func TestTypedGatewayProofRetainsPreparationCopy(t *testing.T) {
	message := "参考图片上传失败，本次尚未开始生成。请稍后重试。"
	body := fmt.Sprintf(`{"error":{"code":"image_reference_upload_failed","message":%q,"metadata":{"submission_state":"not_submitted"}}}`, message)
	failure := ClassifyError(RequestPreparationError{Cause: HTTPError{StatusCode: 503, Body: body}})
	if failure.UserMessage() != message || failure.Uncertain || failure.Retryable || failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() {
		t.Fatalf("typed gateway proof lost to untrusted HTTP guard: %+v", failure)
	}
}
