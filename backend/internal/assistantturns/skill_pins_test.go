package assistantturns_test

import (
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/skills"
	"reflect"
	"strings"
	"testing"
)

func TestTurnSkillPinsPersistAndCannotChangeOnReplay(t *testing.T) {
	fx := openTurnFixture(t)
	pin := skills.Pin{SkillID: "selected", VersionID: "old-version", ContentHash: strings.Repeat("a", 64)}
	turnID := "eeeeaaaabbbbffff"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{pin}}); err != nil {
		t.Fatal(err)
	}
	reopened := assistantturns.New(assistantturns.NewStore(repository.New(fx.db)), testCanvasFactory{base: fx.canvas}, "")
	scope, ok, err := reopened.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || !reflect.DeepEqual(scope.SkillPins, []skills.Pin{pin}) {
		t.Fatalf("scope=%+v ok=%v err=%v", scope, ok, err)
	}
	changed := pin
	changed.VersionID = "new-version"
	if _, err := reopened.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{SkillPins: []skills.Pin{changed}}); err == nil {
		t.Fatal("same turn replay changed skill version")
	}
	if _, err := reopened.Begin(fx.userID, fx.canvasID, "1111111122222222", assistantturns.Input{SkillPins: []skills.Pin{pin, pin}}); err == nil {
		t.Fatal("duplicate skill pin accepted")
	}
}
