package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type laoliReaderResources struct {
	ResourcePort
	data []byte
	t    *testing.T
}

func TestLaoliSignedAssetOrigin(t *testing.T) {
	base := "https://video.laoliimage2.win/v1"
	for _, host := range []string{"video.laoliimage2.win", "accept-auth.laoliimage2.win"} {
		if !trustedLaoliAssetSource(base, "https://"+host+"/v1/media/assets/fixture?signature=test") {
			t.Fatal("provider signed asset rejected", host)
		}
	}
	for _, source := range []string{
		"https://accept-auth.laoliimage2.win.evil.example/v1/media/assets/fixture",
		"https://other.laoliimage2.win/v1/media/assets/fixture",
		"https://accept-auth.laoliimage2.win:444/v1/media/assets/fixture",
		"http://accept-auth.laoliimage2.win/v1/media/assets/fixture",
		"https://user@accept-auth.laoliimage2.win/v1/media/assets/fixture",
		"https://accept-auth.laoliimage2.win/other",
	} {
		if trustedLaoliAssetSource(base, source) {
			t.Fatal("unexpected asset origin accepted", source)
		}
	}
	if trustedLaoliAssetSource("https://unrelated.example", "https://accept-auth.laoliimage2.win/v1/media/assets/fixture") {
		t.Fatal("unrelated service inherited Laoli media origin")
	}
}

func (r laoliReaderResources) Open(userID, resourceID string) (ResourceInfo, io.ReadCloser, error) {
	if userID != "owner" || resourceID != "audio" {
		r.t.Fatal("resource ownership was not forwarded")
	}
	return ResourceInfo{MimeType: "audio/wav"}, io.NopCloser(bytes.NewReader(r.data)), nil
}

func TestLaoliOwnedAudioPreservesMoreThanLegacy15MiB(t *testing.T) {
	data := bytes.Repeat([]byte{42}, (16<<20)+17)
	ctx := WithRuntime(context.Background(), Runtime{Resources: laoliReaderResources{data: data, t: t}})
	for _, declared := range []int64{0, int64(len(data))} {
		got, mime, skip, err := ownedLaoliMediaReader(ctx, "owner")("audio", Media{StorageKey: "resource:audio", Bytes: declared})
		if err != nil || skip || mime != "audio/wav" || !bytes.Equal(got, data) {
			t.Fatalf("audio was rejected or truncated: got=%d err=%v", len(got), err)
		}
	}
	if _, _, _, err := ownedLaoliMediaReader(ctx, "owner")("audio", Media{StorageKey: "resource:audio", Bytes: 100_000_001}); err == nil {
		t.Fatal("oversize audio must fail before opening the resource")
	}
}

func TestLaoliUploadPreservesBytesAndVerifiesReceipt(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, bad := range []string{"", "hash", "origin", "incomplete", "chunk"} {
		t.Run(bad, func(t *testing.T) {
			data := []byte("local reference bytes")
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			var uploaded []byte
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-key" {
					t.Error("missing upload authorization")
				}
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == "PUT":
					if bad == "chunk" {
						http.Error(w, "upload failed", 500)
						return
					}
					b, _ := io.ReadAll(r.Body)
					uploaded = append(uploaded, b...)
					w.Write([]byte(`{}`))
				case strings.HasSuffix(r.URL.Path, "/complete"):
					h := digest
					if bad == "hash" {
						h = "invalid"
					}
					source := "https://" + strings.TrimPrefix(server.URL, "http://") + "/v1/media/assets/fixture?signature=test"
					if bad == "origin" {
						source = "https://different.example/v1/media/assets/fixture"
					}
					status := "complete"
					if bad == "incomplete" {
						status = "uploading"
					}
					json.NewEncoder(w).Encode(laoliUpload{ID: "fixture", Status: status, Kind: "video", MIME: "video/mp4", Bytes: int64(len(data)), SHA256: h, Source: source, Duration: 3})
				default:
					json.NewEncoder(w).Encode(laoliUpload{ID: "fixture", Status: "uploading", ChunkSize: 7})
				}
			}))
			defer server.Close()
			input := Input{Mode: "video", Config: Config{BaseURL: server.URL, APIKey: "fixture-key", InterfaceType: "laoli-video", Model: "sd-native-full-2.5"}, ReferenceVideos: []Media{{StorageKey: "resource:owned"}}}
			err := prepareLaoliReferences(context.Background(), &input, func(kind string, m Media) ([]byte, string, bool, error) { return data, "video/mp4", false, nil })
			if bad != "" {
				if err == nil {
					t.Fatal("invalid upload accepted")
				}
				if input.ReferenceVideos[0].StorageKey == "" {
					t.Fatal("failed upload replaced input")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(uploaded) != string(data) {
				t.Fatal("upload bytes changed")
			}
			if input.ReferenceVideos[0].DurationMs != 3000 || input.ReferenceVideos[0].StorageKey != "" {
				t.Fatal("verified metadata not applied")
			}
		})
	}
}
