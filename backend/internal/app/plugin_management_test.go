package app

import (
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/plugins"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestApplicationPluginUsesUserStateUnderPlatformAvailability(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	center, err := newPluginRuntimeWithStore(t.TempDir(), plugins.NewRepositoryStore(repo))
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repo, pluginRuntime: center}
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin}

	states, err := svc.PluginDomain().StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	initial := states[PluginPortraitClearance]
	if !initial.PlatformAvailable || initial.UserEnabled || initial.EffectiveEnabled || !initial.CanToggle {
		t.Fatalf("initial application state = %#v", initial)
	}

	enabled, err := svc.SetUserPluginEnabled(user, PluginPortraitClearance, true)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.UserConfigured || !enabled.UserEnabled || !enabled.EffectiveEnabled {
		t.Fatalf("enabled application state = %#v", enabled)
	}
	if _, err := svc.SetPluginPlatformAvailability(user, PluginPortraitClearance, false); err == nil {
		t.Fatal("ordinary user changed platform plugin availability")
	}
	disabled, err := svc.SetPluginPlatformAvailability(admin, PluginPortraitClearance, false)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.PlatformAvailable || disabled.EffectiveEnabled || disabled.EnabledUserCount != 1 {
		t.Fatalf("platform-disabled application state = %#v", disabled)
	}
	if _, err := svc.SetPluginPlatformAvailability(admin, PluginPortraitClearance, true); err != nil {
		t.Fatal(err)
	}
	states, err = svc.PluginDomain().StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	if !states[PluginPortraitClearance].EffectiveEnabled {
		t.Fatalf("restored application lost the user's choice: %#v", states[PluginPortraitClearance])
	}
}

func TestUploadedManifestCannotClaimUserActivationScope(t *testing.T) {
	policy := pluginManagement(PluginPortraitClearance, PluginOriginUploaded)
	if policy.Origin != PluginOriginUploaded || policy.ActivationScope != PluginScopeSystem || policy.ConfigurationScope != PluginConfigurationSystem {
		t.Fatalf("uploaded plugin policy = %#v", policy)
	}
}

func TestOfficialApplicationIsUserToggleable(t *testing.T) {
	policy := pluginManagement(PluginPortraitClearance, "bundled")
	if policy.Origin != PluginOriginOfficial || policy.Kind != PluginKindApplication || policy.ActivationScope != PluginScopeUser || policy.ConfigurationScope != PluginConfigurationNone {
		t.Fatalf("official application policy = %#v", policy)
	}
}

func TestOfficialApplicationReportsPlatformAvailableWithoutPlatformState(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	center, err := newPluginRuntimeWithStore(t.TempDir(), plugins.NewRepositoryStore(repo))
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repo, pluginRuntime: center}
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}

	states, err := svc.PluginDomain().StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := states[PluginPortraitClearance]
	if !ok {
		t.Fatalf("official application missing from plugin states: %#v", states)
	}
	if !state.PlatformAvailable || !state.CanToggle {
		t.Fatalf("official application should be user-toggleable, got %#v", state)
	}
	if state.BlockedReason == "管理员已停用该插件" {
		t.Fatalf("official application reported as admin-disabled: %#v", state)
	}
	if retired, exists := states["editor-shell"]; exists {
		t.Fatalf("retired editor-shell should not be registered in plugin states: %#v", retired)
	}
}
