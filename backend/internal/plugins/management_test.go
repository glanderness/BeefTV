package plugins

import (
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestUploadedManifestCannotClaimUserActivationScope(t *testing.T) {
	policy := Management(PromptOptimizer, OriginUploaded)
	if policy.Origin != OriginUploaded || policy.ActivationScope != ScopeSystem || policy.ConfigurationScope != ConfigurationSystem {
		t.Fatalf("uploaded plugin policy = %#v", policy)
	}
}

func TestArtCritiqueIsUserToggleableApplication(t *testing.T) {
	policy := Management(AIArtCritique, "bundled")
	if policy.Origin != OriginOfficial || policy.Kind != KindApplication || policy.ActivationScope != ScopeUser || policy.ConfigurationScope != ConfigurationNone {
		t.Fatalf("AI art critique policy = %#v", policy)
	}
}

func TestEditorShellIsUserToggleableApplication(t *testing.T) {
	policy := Management(EditorShell, "bundled")
	if policy.Origin != OriginOfficial || policy.Kind != KindApplication || policy.ActivationScope != ScopeUser || policy.ConfigurationScope != ConfigurationNone {
		t.Fatalf("editor shell policy = %#v", policy)
	}
}

func TestInstallUploadedRejectsReservedApplicationID(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, &memoryStore{})
	_, err = svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest(PromptOptimizer, "1.0.0")), "prompt-optimizer.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "由官方应用保留") {
		t.Fatalf("reserved id error = %v", err)
	}
}

func TestEditorShellReportsPlatformAvailableWithoutPlatformState(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, &memoryStore{})
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	states, err := svc.StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := states[EditorShell]
	if !ok {
		t.Fatalf("editor shell missing from plugin states: %#v", states)
	}
	if !state.PlatformAvailable || !state.CanToggle {
		t.Fatalf("editor shell should be a user-toggleable application, got %#v", state)
	}
	if state.BlockedReason == "管理员已停用该插件" {
		t.Fatalf("editor shell reported as admin-disabled: %#v", state)
	}
}

func TestApplicationPluginUsesUserStateUnderPlatformAvailability(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, &memoryStore{})
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin}

	states, err := svc.StatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	initial := states[WorkflowRunningHub]
	if !initial.PlatformAvailable || initial.UserEnabled || initial.EffectiveEnabled || !initial.CanToggle {
		t.Fatalf("initial RunningHub state = %#v", initial)
	}

	enabled, err := svc.SetUserEnabled(user, WorkflowRunningHub, true)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.UserConfigured || !enabled.UserEnabled || !enabled.EffectiveEnabled {
		t.Fatalf("enabled RunningHub state = %#v", enabled)
	}
	if _, _, err := svc.SetPlatformAvailability(admin, WorkflowRunningHub, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireWorkflowForUser(user.ID, "runninghub-workflow-image"); err == nil {
		t.Fatal("platform-disabled workflow was accepted for a new user request")
	}
	if _, _, err := svc.SetPlatformAvailability(admin, WorkflowRunningHub, true); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireWorkflowForUser(user.ID, "runninghub-workflow-video"); err != nil {
		t.Fatalf("restored user workflow rejected: %v", err)
	}
}

func TestInstallUploadedRollsBackNewPluginWhenStoreFails(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{failSavePlatform: true}
	svc := New(runtime, store)
	_, err = svc.InstallUploaded("admin-1", testPluginPackage(t, testManifest("store-fail-upload", "1.0.0")), "store-fail-upload.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "保存插件平台状态") {
		t.Fatalf("store failure error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "store-fail-upload"); ok {
		t.Fatal("failed uploaded install left the plugin installed")
	}
}

type memoryStore struct {
	mu               sync.Mutex
	platform         map[string]*model.PluginPlatformState
	users            map[string]*model.UserPluginState
	failSavePlatform bool
}

func (s *memoryStore) PluginPlatformState(pluginID string) (*model.PluginPlatformState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.platform == nil {
		return nil, nil
	}
	state := s.platform[pluginID]
	if state == nil {
		return nil, nil
	}
	copy := *state
	return &copy, nil
}

func (s *memoryStore) UserPluginState(userID, pluginID string) (*model.UserPluginState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users == nil {
		return nil, nil
	}
	state := s.users[userID+"\x00"+pluginID]
	if state == nil {
		return nil, nil
	}
	copy := *state
	return &copy, nil
}

func (s *memoryStore) SaveUserPluginState(state *model.UserPluginState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users == nil {
		s.users = map[string]*model.UserPluginState{}
	}
	copy := *state
	s.users[state.UserID+"\x00"+state.PluginID] = &copy
	return nil
}

func (s *memoryStore) SavePluginPlatformState(state *model.PluginPlatformState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failSavePlatform {
		return errStoreFailed
	}
	if s.platform == nil {
		s.platform = map[string]*model.PluginPlatformState{}
	}
	copy := *state
	s.platform[state.PluginID] = &copy
	return nil
}

func (s *memoryStore) EnabledPluginUserCounts() (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := map[string]int64{}
	for _, state := range s.users {
		if state.Enabled {
			counts[state.PluginID]++
		}
	}
	return counts, nil
}

func (s *memoryStore) DeleteUserPluginStates(pluginID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, state := range s.users {
		if state.PluginID == pluginID {
			delete(s.users, key)
		}
	}
	return nil
}

func (s *memoryStore) DeletePluginPlatformState(pluginID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.platform, pluginID)
	return nil
}

var errStoreFailed = errString("store failed")

type errString string

func (e errString) Error() string { return string(e) }
