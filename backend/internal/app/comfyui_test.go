package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestComfyUILocalTaskHydratesOwnedReferenceAndPersistsResult(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	base, db := newTimelineTaskTestService(t)
	svc := NewLocal(base.repo, t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	ref, err := svc.UploadLocalResourceFile("user", "reference.png", int64(len(png)), "image", 1, 1, 0, bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}
	var creates, uploads atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/upload/image":
			file, _, err := r.FormFile("image")
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if !bytes.Equal(data, png) {
				t.Error("reference bytes were not hydrated from the owned resource")
			}
			uploads.Add(1)
			_, _ = w.Write([]byte(`{"name":"ref.png","subfolder":"beeftv"}`))
		case "/prompt":
			creates.Add(1)
			var payload struct {
				Prompt map[string]struct {
					Inputs map[string]any `json:"inputs"`
				} `json:"prompt"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			if payload.Prompt["1"].Inputs["text"] != "a test scene" || payload.Prompt["2"].Inputs["image"] != "beeftv/ref.png" {
				t.Error("mapped task inputs did not reach ComfyUI")
			}
			_, _ = w.Write([]byte(`{"prompt_id":"local-original"}`))
		case "/history/local-original":
			_, _ = w.Write([]byte(`{"local-original":{"status":{"completed":true,"status_str":"success"},"outputs":{"3":{"images":[{"filename":"out.png","type":"output","subfolder":""}]}}}}`))
		case "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			t.Errorf("unexpected ComfyUI request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	var workflow map[string]any
	_ = json.Unmarshal([]byte(`{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"original"}},"2":{"class_type":"LoadImage","inputs":{"image":"default.png"}},"3":{"class_type":"SaveImage","inputs":{"images":["2",0]}}}`), &workflow)
	input := map[string]any{"mode": "image", "prompt": "a test scene", "config": map[string]any{
		"interfaceType": "comfyui-image", "baseUrl": server.URL, "model": "local-workflow", "workflowJson": workflow,
		"workflowFields": []any{map[string]any{"nodeId": "1", "fieldName": "text", "source": "prompt"}, map[string]any{"nodeId": "2", "fieldName": "image", "source": "referenceImage", "required": true}},
	}, "referenceImages": []any{map[string]any{"id": ref.ID, "storageKey": "resource:" + ref.ID, "type": "image"}}}
	task, err := svc.CreateTask("user", CreateTaskRequest{Type: "canvas_image", Prompt: "a test scene", Input: input})
	if err != nil {
		t.Fatal(err)
	}
	// CreateTask returns the public projection; workers load the protected input.
	task, err = svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	task.Status = model.TaskStatusRunning
	task.LeaseOwner = "comfyui-test-worker"
	expires := time.Now().Add(time.Hour)
	task.LeaseExpiresAt = &expires
	if err := db.Save(task).Error; err != nil {
		t.Fatal(err)
	}
	result, _, err := svc.processTask(context.Background(), *task)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil || stored.ProviderRequestID != "local-original" {
		t.Fatalf("durable receipt=%+v err=%v", stored, err)
	}
	if _, _, err := svc.processTask(context.Background(), *stored); err != nil {
		t.Fatalf("resume original task: %v", err)
	}
	result, err = svc.persistTaskGeneratedMediaResult(*task, result)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if err := svc.saveTaskCompletionWithinStorageQuota(task, encoded, nil, false); err != nil {
		t.Fatal(err)
	}
	stored, err = svc.repo.Task(task.ID)
	if err != nil || stored.Status != model.TaskStatusSucceeded || !strings.Contains(stored.ResultJSON, "resource:") || strings.Contains(stored.ResultJSON, "data:image") {
		t.Fatalf("stored result=%+v err=%v", stored, err)
	}
	if creates.Load() != 1 || uploads.Load() != 1 {
		t.Fatalf("creates=%d uploads=%d", creates.Load(), uploads.Load())
	}
	if _, err := svc.Resource("other-user", ref.ID); err == nil {
		t.Fatal("foreign resource access succeeded")
	}
}

func TestComfyUIInspectRejectsRedirectBeforeSendingCustomCredentials(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var leaked atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	_, err := (&Service{}).InspectComfyUI(context.Background(), ComfyUIInspectRequest{BaseURL: server.URL, APIKey: "synthetic-key", Capability: "image", WorkflowJSON: map[string]any{"1": map[string]any{"class_type": "Note", "inputs": map[string]any{}}}})
	if err == nil || leaked.Load() != 0 {
		t.Fatalf("redirect sent credentials: err=%v requests=%d", err, leaked.Load())
	}
}
