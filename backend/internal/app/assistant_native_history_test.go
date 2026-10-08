package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/operations"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestNativeHistoryAudioKeepsExactSessionPinAcrossCanvasPermission(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	ffmpeg, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "voice.wav")
	if out, err := exec.Command(ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "pcm_s16le", f).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	makeAsset := func(id string) string {
		resource, err := svc.UploadResourceFile("local", id+".wav", int64(len(b)), "audio", 0, 0, 100, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(map[string]any{"id": id, "title": id, "kind": "audio", "coverUrl": "", "tags": []string{}, "data": map[string]any{"storageKey": "resource:" + resource.ID, "bytes": resource.Size, "mimeType": resource.MimeType, "durationMs": 100}})
		if _, err := svc.UpsertUserAsset("local", raw); err != nil {
			t.Fatal(err)
		}
		return resource.ID
	}
	rid := makeAsset("historic-audio")
	otherID := makeAsset("not-read-audio")
	hash := sha256.Sum256(b)
	source := operations.MediaSource{CanvasID: canvasID, AssetID: "historic-audio", ResourceID: rid, Version: hex.EncodeToString(hash[:]), StartMs: 0, EndMs: 100}
	rawDoc, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	json.Unmarshal(rawDoc, &doc)
	doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "history-audio-node", "type": "audio", "title": "voice", "position": map[string]any{"x": 1, "y": 1}, "metadata": map[string]any{"assetId": "historic-audio", "storageKey": "resource:" + rid, "content": "/api/resources/" + rid + "/file"}})
	saveDoc := func() {
		doc["revision"] = canvasRevisionOf(t, svc, canvasID)
		raw, _ := json.Marshal(doc)
		if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
			t.Fatal(err)
		}
	}
	saveDoc()
	nodeSource := source
	nodeSource.AssetID = ""
	nodeSource.NodeID = "history-audio-node"
	const origin = "aaaaaaaaaaaaaaaa"
	const current = "bbbbbbbbbbbbbbbb"
	const session = "durable:11111111-1111-1111-1111-111111111111"
	if _, err := svc.BeginAssistantTurn("local", canvasID, origin, AssistantTurnInput{PermissionMode: assistantturns.PermissionFullAccess, AssetIDs: []string{"historic-audio"}}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", origin, session, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", origin, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", origin, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", origin, origin, session, nodeSource); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(origin); err != nil {
		t.Fatal(err)
	}
	doc["nodes"].([]any)[1].(map[string]any)["metadata"] = map[string]any{"assetId": "not-read-audio", "storageKey": "resource:" + otherID, "content": "/api/resources/" + otherID + "/file"}
	saveDoc()
	if _, err := svc.BeginAssistantTurn("local", canvasID, current, AssistantTurnInput{PermissionMode: assistantturns.PermissionCanvas}); err != nil {
		t.Fatal(err)
	}
	if err := svc.BindAssistantDurableSession("local", current, session, false); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := svc.AssistantTurnScopeForHost("local", current)
	if err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	sc := &agentops.AssistantScope{CanvasID: scope.CanvasID, PermissionMode: scope.PermissionMode}
	raw, _ := json.Marshal(map[string]any{"canvasId": canvasID, "assetId": "historic-audio"})
	if sc.Allows(&operations.Op{ID: "media.overview", ReadOnly: true}, raw) == nil {
		t.Fatal("history widened current tools")
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, source); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, nodeSource); err != nil {
		t.Fatalf("old node output should survive new node content: %v", err)
	}
	if err := svc.RegisterAssistantNativeSource(context.Background(), "local", current, origin, session, nodeSource); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, user, session string
		source              operations.MediaSource
	}{{"other-owner", "other", session, source}, {"foreign-session", "local", "durable:22222222-2222-2222-2222-222222222222", source}, {"full-origin-not-read", "local", session, operations.MediaSource{CanvasID: canvasID, AssetID: "not-read-audio", ResourceID: otherID, Version: source.Version, StartMs: 0, EndMs: 100}}, {"changed-version", "local", session, operations.MediaSource{CanvasID: canvasID, AssetID: source.AssetID, ResourceID: rid, Version: "wrong", StartMs: 0, EndMs: 100}}} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := svc.RevalidateAssistantNativeSource(context.Background(), test.user, current, origin, test.session, test.source); err == nil {
				t.Fatal("unauthorized native history accepted")
			}
		})
	}
	if err := svc.BindAssistantDurableSession("local", origin, "durable:22222222-2222-2222-2222-222222222222", true); err == nil {
		t.Fatal("historical session moved")
	}
	if err := svc.FinalizeAssistantTurn(current); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RevalidateAssistantNativeSource(context.Background(), "local", current, origin, session, source); err == nil {
		t.Fatal("closed current turn allowed dispatch")
	}
}
