package app

import "testing"

func TestSyncGitHubSkillDelegatesInLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	if _, err := svc.SyncGitHubSkill("user-1", "skill-1"); err == nil {
		t.Fatal("expected missing repository error when syncing unknown skill")
	}
}
