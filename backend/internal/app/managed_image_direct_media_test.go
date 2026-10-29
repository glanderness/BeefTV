package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func TestManagedImageDirectReferencesPersistAndReopen(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var encoded bytes.Buffer
	pixels := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	pixels.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 64})
	if err := png.Encode(&encoded, pixels); err != nil {
		t.Fatal(err)
	}
	imageBytes := encoded.Bytes()
	for _, tc := range []struct {
		name, model, size, mode string
		refs, outputs           int
		mask, transparent       bool
		largeReference          bool
	}{
		{name: "Seedream multi-reference", model: "dola-seedream-5-0-pro-260628", size: "2K", refs: 2, outputs: 1},
		{name: "Seedream transparent", model: "dola-seedream-5-0-flash-260915", size: "2K", refs: 1, outputs: 1, transparent: true},
		{name: "Seedream layers", model: "dola-seedream-5-0-pro-260628", size: "2K", mode: "layers", refs: 1, outputs: 2},
		{name: "GPT2 multi-reference mask", model: "gpt-image-2", size: "1024x1024", refs: 2, outputs: 1, mask: true, transparent: true},
		{name: "GPT2.5 text", model: "gpt-image-2.5", size: "1024x1024", outputs: 1},
		{name: "GPT Flare", model: "gpt-image-2.5-flare", size: "1024x1024", refs: 2, outputs: 1},
		{name: "GPT large direct reference", model: "gpt-image-2.5-flare", size: "1024x1024", refs: 1, outputs: 1, largeReference: true},
		{name: "GPT Sunburst mask", model: "gpt-image-2.5-sunburst", size: "1024x1024", refs: 1, outputs: 1, mask: true},
		{name: "HyImage", model: "hy-image-v3", size: "1:1", refs: 3, outputs: 1},
		{name: "Midjourney", model: "midjourney-v8.2", size: "1:1", refs: 1, outputs: 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			referenceBytes := imageBytes
			if tc.largeReference {
				var large bytes.Buffer
				encoder := png.Encoder{CompressionLevel: png.NoCompression}
				pixels := image.NewNRGBA(image.Rect(0, 0, 4096, 4096))
				for i := 3; i < len(pixels.Pix); i += 4 {
					pixels.Pix[i] = 255
				}
				if err := encoder.Encode(&large, pixels); err != nil {
					t.Fatal(err)
				}
				referenceBytes = large.Bytes()
				if len(referenceBytes) <= 30<<20 {
					t.Fatalf("large fixture too small: %d", len(referenceBytes))
				}
			}
			gatewayBytes, storageBytes, posts, puts, completes, downloads := 0, 0, 0, 0, 0, 0
			uploads := map[string]generation.BeefAPISeedanceUploadRequest{}
			objects := map[string][]byte{}
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
					t.Error("storage received gateway credentials")
				}
				if r.Method == http.MethodPut {
					data, _ := io.ReadAll(r.Body)
					storageBytes += len(data)
					puts++
					if r.ContentLength != int64(len(referenceBytes)) || !bytes.Equal(data, referenceBytes) {
						t.Error("direct PUT changed image bytes or length")
					}
					objects[strings.TrimPrefix(r.URL.Path, "/objects/")] = data
					return
				}
				downloads++
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(imageBytes)
			}))
			defer storage.Close()
			var gateway *httptest.Server
			gateway = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.Method == http.MethodGet && r.URL.Path == "/v1/images/proxy" {
					http.Redirect(w, r, storage.URL+"/generated.png", http.StatusFound)
					return
				}
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer synthetic-key" {
					t.Errorf("unexpected gateway request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				data, _ := io.ReadAll(r.Body)
				gatewayBytes += len(data)
				if strings.Contains(string(data), "data:image/") || bytes.Contains(data, imageBytes) || len(data) > 4096 || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("gateway received media bytes or multipart, length=%d", len(data))
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/video-references/uploads":
					var req generation.BeefAPISeedanceUploadRequest
					if err := json.Unmarshal(data, &req); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					digest := sha256.Sum256(referenceBytes)
					if req.Kind != "image" || req.Bytes != int64(len(referenceBytes)) || req.Mime != "image/png" || req.SHA256 != hex.EncodeToString(digest[:]) {
						t.Error("upload metadata differs from local image")
					}
					ticket := fmt.Sprintf("ticket-%d", len(uploads))
					uploads[ticket] = req
					_ = json.NewEncoder(w).Encode(generation.BeefAPISeedanceUploadSession{Ticket: ticket, UploadURL: storage.URL + "/objects/" + ticket, UploadMethod: "PUT", RequiredHeaders: map[string]string{"Content-Type": "image/png"}})
				case "/v1/video-references/uploads/complete":
					var req struct {
						Ticket string `json:"ticket"`
					}
					_ = json.Unmarshal(data, &req)
					metadata, ok := uploads[req.Ticket]
					if !ok || !bytes.Equal(objects[req.Ticket], referenceBytes) {
						t.Error("complete did not validate original ticket and uploaded bytes")
					}
					completes++
					_ = json.NewEncoder(w).Encode(generation.BeefAPISeedanceUploadComplete{URL: storage.URL + "/objects/" + req.Ticket, Kind: metadata.Kind, Mime: metadata.Mime, Bytes: metadata.Bytes, SHA256: metadata.SHA256})
				case "/v1/images/generations", "/v1/images/edits":
					posts++
					var body map[string]any
					_ = json.Unmarshal(data, &body)
					if body["response_format"] != "url" || body["model"] != tc.model {
						t.Errorf("URL contract missing: %#v", body)
					}
					if tc.mask && (r.URL.Path != "/v1/images/edits" || !strings.HasPrefix(body["mask"].(string), storage.URL+"/objects/")) {
						t.Error("mask URL or edits path lost")
					}
					if tc.transparent && (body["background"] != "transparent" || body["output_format"] != "png") {
						t.Error("transparent PNG options lost")
					}
					if tc.model == "midjourney-v8.2" && body["n"] != float64(4) {
						t.Error("fixed four Midjourney outputs lost")
					}
					var refs []any
					if raw, ok := body["image"].(string); ok {
						refs = []any{raw}
					} else if raw, ok := body["image"].([]any); ok {
						refs = raw
					} else if raw, ok := body["images"].([]any); ok {
						refs = raw
					}
					if len(refs) != tc.refs {
						t.Errorf("references=%#v, want %d", refs, tc.refs)
					}
					for i, ref := range refs {
						if ref != storage.URL+fmt.Sprintf("/objects/ticket-%d", i) {
							t.Errorf("reference order changed: %#v", refs)
						}
					}
					items := make([]map[string]any, tc.outputs)
					for i := range items {
						items[i] = map[string]any{"url": gateway.URL + "/v1/images/proxy", "z_index": i + 1, "name": fmt.Sprintf("layer-%d", i)}
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"data": items, "usage": map[string]any{"total_tokens": 7}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer gateway.Close()
			path, dataDir := filepath.Join(t.TempDir(), "workspace.db"), t.TempDir()
			svc, db := newManagedImageDirectService(t, path, dataDir)
			input := generation.Input{Mode: "image", Prompt: "synthetic fixture", Config: generation.Config{BaseURL: gateway.URL, APIKey: "synthetic-key", Model: tc.model, InterfaceType: "openai-image", Size: tc.size, SeedreamMode: tc.mode}}
			if tc.model == "midjourney-v8.2" {
				input.Config.Count = "4"
			}
			if tc.transparent {
				input.Config.TransparentBackground = "true"
			}
			for i := 0; i < tc.refs; i++ {
				input.ReferenceImages = append(input.ReferenceImages, seedManagedImageLocalResource(t, svc, fmt.Sprintf("reference-%d", i), referenceBytes))
			}
			if tc.mask {
				mask := seedManagedImageLocalResource(t, svc, "mask", referenceBytes)
				input.Mask = &mask
			}
			ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: gateway.URL})
			ctx = svc.bindGenerationRuntime(ctx, generation.CallMeta{UserID: "user-1", TaskID: "original-task", TaskType: "canvas_image"})
			ctx = generation.WithProtocolRegistry(ctx, generation.LoadOfficialFallbackRegistry())
			result, err := generation.Execute(ctx, input)
			if err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			wantUploads := tc.refs
			if tc.mask {
				wantUploads++
			}
			if tc.mode == "layers" {
				layers := result["imageLayers"].([]map[string]any)
				if len(layers) != 2 || layers[1]["name"] != "layer-1" || layers[1]["z_index"] != float64(2) {
					t.Fatalf("layers lost: %#v", layers)
				}
			}
			if result["usage"].(map[string]any)["total_tokens"] != float64(7) {
				t.Fatalf("usage lost: %#v", result)
			}
			inputJSON, _ := json.Marshal(input)
			task := model.Task{ID: "original-task", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusRunning, InputJSON: string(inputJSON)}
			if err := db.Create(&task).Error; err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			resultJSON, _ := json.Marshal(result)
			if err := svc.saveTaskCompletionWithinStorageQuota(&task, resultJSON, nil, false); err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			stored, err := svc.repo.Task(task.ID)
			if err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			if err := svc.DeliverSucceededTask(*stored); err != nil {
				closeDB(t, db)
				t.Fatal(err)
			}
			mu.Lock()
			if posts != 1 || puts != wantUploads || completes != wantUploads || downloads != tc.outputs || storageBytes != wantUploads*len(referenceBytes) {
				mu.Unlock()
				closeDB(t, db)
				t.Fatalf("posts=%d puts=%d completes=%d downloads=%d storageBytes=%d gatewayBytes=%d", posts, puts, completes, downloads, storageBytes, gatewayBytes)
			}
			t.Logf("reference_bytes=%d storage_put_bytes=%d gateway_json_bytes=%d paid_create_count=%d", len(referenceBytes), storageBytes, gatewayBytes, posts)
			mu.Unlock()
			closeDB(t, db)
			svc, db = newManagedImageDirectService(t, path, dataDir)
			defer closeDB(t, db)
			reopened, err := svc.Task("user-1", task.ID)
			if err != nil || len(reopened.Outputs) != tc.outputs {
				t.Fatalf("reopened task outputs=%d, error=%v", len(reopened.Outputs), err)
			}
			for _, item := range reopened.Outputs {
				resource, err := svc.Resource("user-1", item.ResourceID)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
				if err != nil || !bytes.Equal(actual, imageBytes) || resource.MimeType != "image/png" {
					t.Fatalf("reopened image changed: %v", err)
				}
			}
		})
	}
}

func newManagedImageDirectService(t *testing.T, path, dataDir string) (*Service, *gorm.DB) {
	t.Helper()
	svc, db := newGenerationDeliveryMediaService(t, path, dataDir)
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	return NewLocal(svc.repo, dataDir), db
}

func seedManagedImageLocalResource(t *testing.T, svc *Service, id string, data []byte) generation.Media {
	t.Helper()
	key := "users/user-1/image/" + id + ".png"
	path := filepath.Join(svc.dataDir, "resources", filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	metadata, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: id, UserID: "user-1", Kind: "image", Provider: "local", ObjectKey: key, MimeType: "image/png", Status: model.ResourceStatusReady, Size: int64(len(data)), Width: metadata.Width, Height: metadata.Height}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	return generation.Media{StorageKey: "resource:" + id}
}
