package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCanvasQuotaReadsPolicyFromItsTransaction(t *testing.T) {
	s, db := newTimelineTaskTestService(t)
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.repo = repository.New(db.WithContext(ctx))
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Only this transaction sees the invalid policy. Returning a root/default
		// policy would either permit this write or wait for our own connection.
		if err := tx.Create(&model.SystemSetting{Key: "runtime_policy", ValueJSON: "{"}).Error; err != nil {
			return err
		}
		repo := s.repo.WithTx(tx)
		host := newCanvasHostWithRepo(s, repo)
		for _, check := range []func() error{
			func() error { return host.StructuredQuota("user", "canvas", false, 1) },
			func() error { return host.StructuredBatchQuota("user", "asset", 1, 1) },
			func() error { return host.StructuredReplacementQuota("user", "asset", 1, 1) },
			func() error { return (creationQuotaAdapter{s}).ValidateCanvas("user", repo, false, 1) },
		} {
			if err := check(); err == nil || !strings.Contains(err.Error(), "配置格式无效") {
				t.Fatalf("expected in-transaction policy rejection, got %v", err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
