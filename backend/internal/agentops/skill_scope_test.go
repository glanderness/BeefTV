package agentops_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/skills"
	"testing"
)

func TestSkillReadRequiresExactExplicitPin(t *testing.T) {
	pin := skills.Pin{SkillID: "skill-one", VersionID: "version-one", ContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	scope := &agentops.AssistantScope{CanvasID: "canvas", SkillPins: map[string]skills.Pin{pin.SkillID: pin}}
	for _, op := range []string{"skill.get", "skill.file"} {
		raw, _ := json.Marshal(pin)
		if err := scope.Allows(&agentops.Op{ID: op}, raw); err != nil {
			t.Fatal(err)
		}
		for _, other := range []skills.Pin{{SkillID: pin.SkillID, VersionID: "new-version", ContentHash: pin.ContentHash}, {SkillID: "unselected", VersionID: pin.VersionID, ContentHash: pin.ContentHash}, {SkillID: pin.SkillID, VersionID: pin.VersionID, ContentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}} {
			raw, _ := json.Marshal(other)
			if err := scope.Allows(&agentops.Op{ID: op}, raw); err == nil {
				t.Fatalf("unselected version accepted: %+v", other)
			}
		}
		empty := &agentops.AssistantScope{CanvasID: "canvas"}
		if err := empty.Allows(&agentops.Op{ID: op}, raw); err == nil {
			t.Fatal("installed list implicitly authorized read")
		}
	}
}
