package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/outbound"
)

func TestUploadThenCreateUsesSharedKeyAndComfyUIFileNames(t *testing.T) {
	var events []string
	uploads := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.HasSuffix(req.URL, "/openapi/v2/media/upload/binary"):
			events = append(events, "upload")
			uploads++
			r, _ := http.NewRequest(http.MethodPost, req.URL, bytes.NewReader(req.Body))
			r.Header.Set("Content-Type", req.ContentType)
			outbound.ApplyOutboundHeaders(r, req.Headers)
			if r.Header.Get("Authorization") != "Bearer consumer-key" || r.Header.Get("X-Custom") != "preserved" {
				t.Fatal("upload did not use the workflow credential and retain custom headers")
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			defer r.MultipartForm.RemoveAll()
			if r.FormValue("apiKey") != "" || r.FormValue("fileType") != "" {
				t.Fatal("legacy upload fields were sent")
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(file)
			file.Close()
			if string(data) != "a" {
				t.Fatalf("uploaded bytes = %q", data)
			}
			return []byte(fmt.Sprintf(`{"code":0,"data":{"fileName":"openapi/input-%d.png","download_url":"https://temporary.example/should-not-be-used"}}`, uploads)), "application/json", nil
		case strings.HasSuffix(req.URL, "/task/openapi/create"):
			events = append(events, "create")
			var body struct {
				APIKey     string `json:"apiKey"`
				WorkflowID string `json:"workflowId"`
				Nodes      []struct {
					NodeID     string `json:"nodeId"`
					FieldValue string `json:"fieldValue"`
				} `json:"nodeInfoList"`
			}
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body.APIKey != "consumer-key" || body.WorkflowID != "wf-1" || uploads != 5 {
				t.Fatal("task submitted before uploads or with a different credential")
			}
			got := map[string]string{}
			for _, node := range body.Nodes {
				got[node.NodeID] = node.FieldValue
			}
			want := map[string]string{"6": "openapi/input-1.png", "35": "openapi/input-2.png", "7": "openapi/input-3.png", "8": "openapi/input-4.png", "9": "openapi/input-5.png"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("node mapping = %#v, want %#v", got, want)
			}
			return []byte(`{"code":0,"data":{"taskId":"accepted-1"}}`), "application/json", nil
		case strings.HasSuffix(req.URL, "/task/openapi/outputs"):
			events = append(events, "poll")
			var body map[string]any
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body["apiKey"] != "consumer-key" || body["taskId"] != "accepted-1" {
				t.Fatal("poll did not use the original key and task")
			}
			return pngJSON(), "application/json", nil
		case strings.HasSuffix(req.URL, "/out.png"):
			return []byte("PNGDATA"), "image/png", nil
		default:
			t.Fatalf("unexpected URL %s", req.URL)
			return nil, "", nil
		}
	}}
	input := imageCreateInput()
	input.Config.APIKey = "consumer-key"
	input.Config.Headers = []outbound.OutboundHeader{{Name: "authorization", Value: "Bearer stale-key"}, {Name: "X-Custom", Value: "preserved"}}
	input.Config.WorkflowFields = []Field{
		{NodeID: "6", FieldName: "image", Source: "referenceImage", Required: true},
		{NodeID: "35", FieldName: "image", Source: "referenceImage", SourceIndex: 1, Required: true},
		{NodeID: "7", FieldName: "video", Source: "referenceVideo", Required: true},
		{NodeID: "8", FieldName: "audio", Source: "referenceAudio", Required: true},
		{NodeID: "9", FieldName: "image", Source: "mask", Required: true},
	}
	input.ReferenceImages = []Media{{ID: "image-1", DataURL: "data:image/png;base64,YQ=="}, {ID: "image-2", DataURL: "data:image/png;base64,YQ=="}}
	input.ReferenceVideos = []Media{{ID: "video-1", DataURL: "data:video/mp4;base64,YQ=="}}
	input.ReferenceAudios = []Media{{ID: "audio-1", DataURL: "data:audio/mpeg;base64,YQ=="}}
	input.Mask = &Media{ID: "mask-1", DataURL: "data:image/png;base64,YQ=="}
	if _, err := productionClient(exec).Run(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(events, []string{"upload", "upload", "upload", "upload", "upload", "create", "poll"}) {
		t.Fatalf("events = %#v", events)
	}
}

func TestUploadFailureNeverSubmitsWorkflow(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		err        error
	}{
		{name: "unauthorized", err: StatusError{StatusCode: 401, Body: "ApiKey verification failed"}},
		{name: "business error", body: `{"code":401,"msg":"invalid key","data":{"fileName":"openapi/invalid.png"}}`},
		{name: "missing filename", body: `{"code":0,"data":{"download_url":"https://temporary.example/input.png"}}`},
		{name: "missing business code", body: `{"data":{"fileName":"openapi/input.png"}}`},
		{name: "invalid JSON", body: `<html>error</html>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if !strings.HasSuffix(req.URL, "/openapi/v2/media/upload/binary") {
					t.Fatalf("failed upload must not create or poll: %s", req.URL)
				}
				return []byte(tc.body), "application/json", tc.err
			}}
			input := imageCreateInput()
			input.Config.WorkflowFields = []Field{{NodeID: "6", FieldName: "image", Source: "referenceImage", Required: true}}
			input.ReferenceImages = []Media{{ID: "image-1", DataURL: "data:image/png;base64,YQ=="}}
			if _, err := productionClient(exec).Run(context.Background(), input); err == nil {
				t.Fatal("upload failure was ignored")
			}
		})
	}
}

func TestResumeWithMediaDoesNotUploadOrCreateAgain(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.HasSuffix(req.URL, "/task/openapi/outputs") {
			return pngJSON(), "application/json", nil
		}
		if strings.HasSuffix(req.URL, "/out.png") {
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("resume unexpectedly called %s", req.URL)
		return nil, "", nil
	}}
	input := imageCreateInput()
	input.ResumedRequestID = "original-task"
	input.ReferenceImages = []Media{{ID: "image-1", DataURL: "data:image/png;base64,YQ=="}}
	client := productionClient(exec)
	client.Receipt = nil
	client.Media = nil
	if _, err := client.Run(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}
