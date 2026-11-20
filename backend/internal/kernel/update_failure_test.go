package kernel

import "testing"

func TestUpdateFailureVocabularyAndWindowsErrnoMapping(t *testing.T) {
	for _, step := range updateSteps {
		if !IsValidUpdateStep(step) {
			t.Fatalf("step %q reported invalid", step)
		}
		meta := UpdateFailureMeta{Step: step, Reason: UpdateReasonFailed, Errno: 32, HasErrno: true, ExitCode: 3221225477, HasExitCode: true}
		formatted := meta.Format()
		parsed, ok := ParseUpdateFailureMeta(formatted)
		if !ok || parsed != meta {
			t.Fatalf("round-trip mismatch for step %q: formatted=%q parsed=%+v ok=%t", step, formatted, parsed, ok)
		}
		if got := SanitizeUpdateFailureMeta(formatted); got != formatted {
			t.Fatalf("step %q did not survive sanitizer: got=%q want=%q", step, got, formatted)
		}
	}
	if IsValidUpdateStep("unknown_step") {
		t.Fatal("unknown_step must be rejected")
	}
	for _, reason := range updateFailureReasons {
		if !reason.Valid() {
			t.Fatalf("reason %q reported invalid", reason)
		}
		meta := UpdateFailureMeta{Reason: reason}
		formatted := meta.Format()
		parsed, ok := ParseUpdateFailureMeta(formatted)
		if !ok || parsed != meta {
			t.Fatalf("round-trip mismatch for reason %q: formatted=%q parsed=%+v ok=%t", reason, formatted, parsed, ok)
		}
		if got := SanitizeUpdateFailureMeta(formatted); got != formatted {
			t.Fatalf("reason %q did not survive sanitizer: got=%q want=%q", reason, got, formatted)
		}
	}
	if UpdateFailureReason("unknown_reason").Valid() {
		t.Fatal("unknown_reason must be rejected")
	}
	for _, item := range updateFailureTextMarkers {
		if !item.reason.Valid() {
			t.Fatalf("text marker %q maps to non-allowlisted reason %q", item.marker, item.reason)
		}
	}

	winCases := map[uint32]UpdateFailureReason{
		Win32ErrorFileNotFound:           UpdateReasonFileNotFound,
		Win32ErrorPathNotFound:           UpdateReasonFileNotFound,
		Win32ErrorAccessDenied:           UpdateReasonPermissionDenied,
		Win32ErrorSharingViolation:       UpdateReasonSharingViolation,
		Win32ErrorLockViolation:          UpdateReasonLockViolation,
		Win32ErrorHandleDiskFull:         UpdateReasonDiskFull,
		Win32ErrorDiskFull:               UpdateReasonDiskFull,
		Win32ErrorVirusInfected:          UpdateReasonVirusBlocked,
		Win32ErrorVirusDeleted:           UpdateReasonVirusBlocked,
		Win32ErrorElevationRequired:      UpdateReasonElevationRequired,
		Win32ErrorAccessDisabledByPolicy: UpdateReasonPolicyBlocked,
		9999:                             "",
	}
	for code, want := range winCases {
		got := ClassifyWindowsUpdateErrno(code)
		if got != want {
			t.Fatalf("ClassifyWindowsUpdateErrno(%d) = %q, want %q", code, got, want)
		}
		if got != "" && !got.Valid() {
			t.Fatalf("ClassifyWindowsUpdateErrno(%d) returned non-allowlisted reason %q", code, got)
		}
	}
}
