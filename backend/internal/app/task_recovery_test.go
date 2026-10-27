package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestRecoverTaskRestoresAcceptedImageWithoutSubmitting(t *testing.T) {
	allowLoopbackProviderTest(t)
	s, db, _, _ := creationTestService(t)
	png, err := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	var gets int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("recovery submitted %s", r.Method)
		}
		gets++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer server.Close()
	task := model.Task{ID: "recover-image", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"mode":"image"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{
		ID: "recover-image-receipt", UserID: task.UserID, TaskID: task.ID,
		Capability: "image", RequestKind: "create", Method: "POST",
		Path: "/v1/images/generations", APIFormat: "openai",
		Status: model.ApiCallStatusSucceeded, StatusCode: 200,
		ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, server.URL+"/original.png"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	result, err := s.RecoverTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || !result.Recovered || result.Task == nil || result.Task.ID != task.ID || result.Task.Status != model.TaskStatusSucceeded {
		t.Fatalf("recovery result = %+v", result)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeliverSucceededTask(*stored); err != nil {
		t.Fatal(err)
	}
	if gets != 1 {
		t.Fatalf("delivery GET count = %d", gets)
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("task count = %d, err=%v", count, err)
	}
}

func TestRecoverTaskWithNoProviderIdentityNeverRetries(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	task := model.Task{ID: "recover-video-no-id", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	if _, err := s.RecoverTask(context.Background(), task.UserID, task.ID); err == nil {
		t.Fatal("query-only recovery submitted or silently accepted a task without provider identity")
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("task count = %d, err=%v", count, err)
	}
}
