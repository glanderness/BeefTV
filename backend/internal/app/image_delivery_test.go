package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestImageDeliveryCompositesRecoveredLocalMaskBeforeSaving(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	makePNG := func(first, second color.NRGBA) string {
		img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
		img.SetNRGBA(0, 0, first)
		img.SetNRGBA(1, 0, second)
		var body bytes.Buffer
		if err := png.Encode(&body, img); err != nil {
			t.Fatal(err)
		}
		return generation.DataURL("image/png", body.Bytes())
	}
	red, green := color.NRGBA{R: 200, A: 255}, color.NRGBA{G: 150, A: 255}
	input, _ := json.Marshal(generation.Input{Mode: "image", ReferenceImages: []generation.Media{{DataURL: makePNG(red, red)}}, Mask: &generation.Media{DataURL: makePNG(color.NRGBA{A: 255}, color.NRGBA{})}, Metadata: map[string]any{"maskEditMode": "local-composite"}})
	task := model.Task{ID: "recovered-local-mask", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, InputJSON: string(input)}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	receipt, _ := json.Marshal(map[string]any{"mode": "image", "images": []any{map[string]any{"url": makePNG(green, green)}}})
	if err := s.saveTaskCompletionWithinStorageQuota(&task, receipt, nil, false); err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Images []struct {
			DataURL    string `json:"dataUrl"`
			StorageKey string `json:"storageKey"`
			ResourceID string `json:"resourceId"`
		} `json:"images"`
		Done bool `json:"localMaskComposited"`
	}
	if err := json.Unmarshal([]byte(stored.ResultJSON), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Done || len(result.Images) != 1 {
		t.Fatal("completion saved raw provider output")
	}
	if strings.Contains(stored.ResultJSON, "data:image/") {
		t.Fatal("recovered local mask persisted raw base64 into tasks.result_json")
	}
	if result.Images[0].ResourceID == "" || result.Images[0].StorageKey != "resource:"+result.Images[0].ResourceID {
		t.Fatalf("recovered local mask did not materialize resource: %+v", result.Images[0])
	}
	_, body, err := s.OpenResource(task.UserID, result.Images[0].ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if color.NRGBAModel.Convert(img.At(0, 0)) != red || color.NRGBAModel.Convert(img.At(1, 0)) != green {
		t.Fatal("recovered image did not preserve original pixels outside selection")
	}
}

func TestImageDeliveryRetainsEncryptedAuthUntilMaterialized(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets++
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer download-secret" || r.Header.Get("X-Provider") != "fixture" {
			t.Error("download lost original auth")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	task := model.Task{ID: "authenticated-image", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning,
		InputJSON: `{"mode":"image","referenceImages":["private-reference"],"config":{"interfaceType":"openai-image","apiFormat":"openai","baseUrl":"` + srv.URL + `","apiKey":"download-secret","headers":[{"name":"X-Provider","value":"fixture"}],"systemPrompt":"private-prompt"}}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result := []byte(`{"mode":"image","images":[{"url":"` + srv.URL + `/image.png"}]}`)
	if err := s.saveTaskCompletionWithinStorageQuota(&task, result, nil, false); err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.InputJSON, "download-secret") || strings.Contains(stored.InputJSON, "private-reference") || strings.Contains(stored.InputJSON, "private-prompt") || !strings.Contains(stored.InputJSON, encryptedSettingPrefix) {
		t.Fatal("completion did not retain only encrypted download configuration")
	}
	if strings.Contains(taskForOutput(*stored).InputJSON, "imageDeliveryCipher") {
		t.Fatal("public task exposed download configuration")
	}
	adapter := generationDeliveryMediaAdapter{service: s}
	if headers, err := adapter.imageDownloadHeaders("user", task.ID+":0", "image", "https://8.8.8.8/image.png"); err != nil || len(headers) != 0 {
		t.Fatalf("external download received provider auth: %v", err)
	}
	if _, err := adapter.imageDownloadHeaders("other", task.ID+":0", "image", srv.URL+"/image.png"); err == nil {
		t.Fatal("foreign owner obtained download auth")
	}
	if err := s.DeliverSucceededTask(*stored); err != nil {
		t.Fatal(err)
	}
	stored, err = s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gets != 1 || strings.Contains(stored.InputJSON, "imageDeliveryCipher") {
		t.Fatalf("download/secret cleanup: gets=%d input=%s", gets, stored.InputJSON)
	}
	if stored.WorkflowSourceCipher == "" {
		t.Fatal("image result delivery removed reusable source snapshot")
	}
}
