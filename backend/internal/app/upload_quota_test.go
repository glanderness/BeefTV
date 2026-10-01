package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestReserveUserUploadQuotaRejectsSingleFileAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	_, err := svc.reserveUserUploadQuota("user-1", megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB))
	if err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("reserveUserUploadQuota() error = %v", err)
	}
}

func TestReserveUserUploadQuotaRejectsDailyTotalAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	daily := megabytes(defaultRuntimePolicy().Resource.DailyUploadMB)
	chunk := int64(49 << 20)
	for used := int64(0); used+chunk <= daily; used += chunk {
		if _, err := svc.reserveUserUploadQuota("user-1", chunk); err != nil {
			t.Fatal(err)
		}
	}
	// 单文件限(50MB)未命中、今日额度已满 → 拒绝并提示每日上限。
	if _, err := svc.reserveUserUploadQuota("user-1", chunk); err == nil || !strings.Contains(err.Error(), "小于 2GB") {
		t.Fatalf("reserveUserUploadQuota() error = %v", err)
	}
}

func TestReleaseUserUploadQuotaRestoresCapacity(t *testing.T) {
	svc := newResourceTestService(t)
	day, err := svc.reserveUserUploadQuota("user-1", 49<<20)
	if err != nil {
		t.Fatal(err)
	}
	svc.releaseUserUploadQuota("user-1", day, 49<<20)
	if _, err := svc.reserveUserUploadQuota("user-1", 49<<20); err != nil {
		t.Fatal(err)
	}
}

func TestCommitUserUploadQuotaKeepsDailyUsageWithoutPendingStorage(t *testing.T) {
	svc := newResourceTestService(t)
	day, err := svc.reserveUserUploadQuota("user-1", 49<<20)
	if err != nil {
		t.Fatal(err)
	}
	svc.commitUserUploadQuota("user-1", 49<<20)
	if svc.pendingStorage["user-1"] != 0 {
		t.Fatalf("pending storage = %d", svc.pendingStorage["user-1"])
	}
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 49<<20 {
		t.Fatalf("daily usage = %d", usage)
	}
}

func TestReserveUserUploadQuotaRejectsTotalStoredFilesAtLimit(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, Size: gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) - 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.reserveUserUploadQuota("user-1", 1); err == nil || !strings.Contains(err.Error(), "20GB 上限") {
	}
}

func TestReserveGeneratedResourceQuotaAllowsUploadLimitAndRejectsGeneratedCap(t *testing.T) {
	svc := newResourceTestService(t)
	uploadLimit := megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB)
	generatedLimit := megabytes(defaultRuntimePolicy().Resource.GeneratedFileMB)
	if _, err := svc.reserveUserUploadQuota("user-1", uploadLimit); err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("upload at ResourceUploadMB error = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-1", uploadLimit); err != nil {
		t.Fatalf("generated at ResourceUploadMB = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-2", generatedLimit); err != nil {
		t.Fatalf("generated at GeneratedFileMB = %v", err)
	}
	if _, err := svc.reserveGeneratedResourceQuota("user-3", generatedLimit+1); err == nil || !strings.Contains(err.Error(), "不能超过 64MB") {
		t.Fatalf("generated above GeneratedFileMB error = %v", err)
	}
}

func TestReserveRetryGeneratedQuotaUsesGeneratedFileLimit(t *testing.T) {
	svc := newResourceTestService(t)
	uploadLimit := megabytes(defaultRuntimePolicy().Resource.ResourceUploadMB)
	generatedLimit := megabytes(defaultRuntimePolicy().Resource.GeneratedFileMB)
	if _, err := svc.reserveRetryUploadQuota("user-1", uploadLimit); err == nil || !strings.Contains(err.Error(), "小于 50MB") {
		t.Fatalf("retry upload at ResourceUploadMB error = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-1", uploadLimit); err != nil {
		t.Fatalf("retry generated at ResourceUploadMB = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-2", generatedLimit); err != nil {
		t.Fatalf("retry generated at GeneratedFileMB = %v", err)
	}
	if _, err := svc.reserveRetryGeneratedQuota("user-3", generatedLimit+1); err == nil || !strings.Contains(err.Error(), "不能超过 64MB") {
		t.Fatalf("retry generated above GeneratedFileMB error = %v", err)
	}
}

func TestAccountFileStorageUsageUsesStoredFilePolicy(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{ID: "resource-1", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "ready.png", Size: 3 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-duplicate", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "", ObjectKey: "ready.png", Size: 3 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-failed", UserID: "user-1", Status: model.ResourceStatusFailed, Provider: "local", ObjectKey: "failed.png", Size: 7 << 20}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.Create(&model.Resource{ID: "resource-pending", UserID: "user-1", Status: model.ResourceStatusPending, Provider: "local", ObjectKey: "pending.png", Size: 11 << 20}); err != nil {
		t.Fatal(err)
	}
	usage, err := svc.AccountFileStorageUsage("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != 3<<20 || usage.TotalBytes != gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) {
		t.Fatalf("AccountFileStorageUsage() = %#v", usage)
	}
}
