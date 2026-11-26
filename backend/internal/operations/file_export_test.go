package operations

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type fakeDeliverableDomain struct {
	Domain
	saved []struct {
		key      string
		fileName string
		mimeType string
		content  string
	}
}

func (f *fakeDeliverableDomain) UserCanvasProject(_, _ string) (json.RawMessage, error) {
	return json.RawMessage(`{"nodes":[],"connections":[]}`), nil
}

func (f *fakeDeliverableDomain) SaveAssistantDeliverableFile(_ context.Context, _, uploadKey, fileName, mimeType string, content []byte) (*model.Resource, error) {
	f.saved = append(f.saved, struct {
		key      string
		fileName string
		mimeType string
		content  string
	}{key: uploadKey, fileName: fileName, mimeType: mimeType, content: string(content)})
	return &model.Resource{
		ID:       "res-export-1",
		MimeType: mimeType,
		Size:     int64(len(content)),
		Status:   model.ResourceStatusReady,
	}, nil
}

func TestFileExportSanitizesFileNameAndPersistsDeliverable(t *testing.T) {
	dom := &fakeDeliverableDomain{}
	ctx := &Context{
		Context:     context.Background(),
		UserID:      "owner",
		OperationID: "op-export-1",
		Domain:      dom,
	}
	raw, _ := json.Marshal(map[string]any{
		"canvasId": "canvas-1",
		"fileName": "../episode1:script.srt",
		"content":  "1\n00:00:00,000 --> 00:00:02,000\n你好 BeefTV\n",
	})
	out, err := opFileExport(ctx, raw)
	if err != nil {
		t.Fatalf("opFileExport failed: %v", err)
	}
	m, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type: %T", out)
	}
	if m["resourceId"] != "res-export-1" || m["fileName"] != "episode1_script.srt" {
		t.Fatalf("unexpected result: %+v", m)
	}
	if len(dom.saved) != 1 || dom.saved[0].key != "file-export:op-export-1" {
		t.Fatalf("unexpected saved record: %+v", dom.saved)
	}
	if dom.saved[0].mimeType != "application/x-subrip; charset=utf-8" {
		t.Fatalf("unexpected mimeType: %q", dom.saved[0].mimeType)
	}
}
