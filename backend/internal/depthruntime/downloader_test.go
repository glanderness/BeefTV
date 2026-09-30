package depthruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadFallsBackAndPublishesOnlyVerifiedFile(t *testing.T) {
	payload := []byte("verified depth model")
	sum := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/primary" {
			http.Error(w, "unavailable", http.StatusBadGateway)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "models", "small.pth")
	var updates []Progress
	err := Download(context.Background(), Artifact{
		URLs: []string{server.URL + "/primary", server.URL + "/fallback"},
		Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]),
	}, target, func(progress Progress) { updates = append(updates, progress) })
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != string(payload) {
		t.Fatalf("published file = %q, err=%v", data, err)
	}
	if len(updates) == 0 || updates[len(updates)-1].Downloaded != int64(len(payload)) {
		t.Fatalf("progress = %#v", updates)
	}
}

func TestDownloadRejectsChecksumMismatchWithoutPublishing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("corrupt")) }))
	defer server.Close()
	target := filepath.Join(t.TempDir(), "small.pth")

	err := Download(context.Background(), Artifact{URLs: []string{server.URL}, Size: 7, SHA256: string(make([]byte, 64))}, target, nil)
	if err == nil {
		t.Fatal("expected checksum error")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("target should not be published, stat err=%v", statErr)
	}
}

func TestDownloadRetriesAnInterruptedSourceAndResumes(t *testing.T) {
	payload := []byte("resumable verified runtime")
	sum := sha256.Sum256(payload)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			_, _ = w.Write(payload[:8])
			return
		}
		if got := r.Header.Get("Range"); got != "bytes=8-" {
			t.Errorf("range = %q", got)
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 8-%d/%d", len(payload)-1, len(payload)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[8:])
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "runtime.zip")
	err := Download(context.Background(), Artifact{URLs: []string{server.URL}, Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}, target, nil)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestDownloadAssemblesVerifiedReleaseParts(t *testing.T) {
	whole := []byte("three signed release chunks")
	chunks := [][]byte{whole[:8], whole[8:17], whole[17:]}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for index, part := range chunks {
			if r.URL.Path == fmt.Sprintf("/part-%d", index) {
				_, _ = w.Write(part)
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	parts := make([]ArtifactPart, 0, len(chunks))
	for index, part := range chunks {
		hash := sha256.Sum256(part)
		parts = append(parts, ArtifactPart{URLs: []string{fmt.Sprintf("%s/part-%d", server.URL, index)}, Size: int64(len(part)), SHA256: hex.EncodeToString(hash[:])})
	}
	wholeHash := sha256.Sum256(whole)
	target := filepath.Join(t.TempDir(), "runtime.zip")
	if err := os.WriteFile(target, []byte("stale corrupt cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Download(context.Background(), Artifact{Size: int64(len(whole)), SHA256: hex.EncodeToString(wholeHash[:]), Parts: parts}, target, nil); err != nil {
		t.Fatalf("assemble: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != string(whole) {
		t.Fatalf("assembled archive = %q, %v", got, err)
	}
}

func TestDownloadRejectsReleasePartWithBadHash(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("bad")) }))
	defer server.Close()
	target := filepath.Join(t.TempDir(), "runtime.zip")
	wholeHash := sha256.Sum256([]byte("good"))
	err := Download(context.Background(), Artifact{Size: 3, SHA256: hex.EncodeToString(wholeHash[:]), Parts: []ArtifactPart{{URLs: []string{server.URL}, Size: 3, SHA256: hex.EncodeToString(wholeHash[:])}}}, target, nil)
	if err == nil {
		t.Fatal("corrupt release part was accepted")
	}
	if pathExists(target) {
		t.Fatal("corrupt assembled archive was published")
	}
}

func TestDownloadRejectsAssembledArchiveWithBadHash(t *testing.T) {
	part := []byte("valid-part")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(part) }))
	defer server.Close()
	partHash := sha256.Sum256(part)
	wrongWholeHash := sha256.Sum256([]byte("different archive"))
	target := filepath.Join(t.TempDir(), "runtime.zip")
	err := Download(context.Background(), Artifact{
		Size: int64(len(part)), SHA256: hex.EncodeToString(wrongWholeHash[:]),
		Parts: []ArtifactPart{{URLs: []string{server.URL}, Size: int64(len(part)), SHA256: hex.EncodeToString(partHash[:])}},
	}, target, nil)
	if err == nil || pathExists(target) {
		t.Fatalf("bad complete archive hash was accepted: %v", err)
	}
}

func TestDownloadRejectsReleasePartsWhoseSizesDoNotAddUp(t *testing.T) {
	hash := sha256.Sum256([]byte("whole"))
	err := Download(context.Background(), Artifact{
		Size: 5, SHA256: hex.EncodeToString(hash[:]),
		Parts: []ArtifactPart{{URLs: []string{"https://example.invalid/part"}, Size: 4, SHA256: hex.EncodeToString(hash[:])}},
	}, filepath.Join(t.TempDir(), "runtime.zip"), nil)
	if err == nil {
		t.Fatal("mismatched release part total was accepted")
	}
}
