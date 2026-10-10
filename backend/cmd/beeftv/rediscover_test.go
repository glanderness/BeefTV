package main

import (
	"context"
	"infinite-canvas/backend/internal/runtimeinfo"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
)

func TestClientFollowsRuntimeForOperationsAndBusiness(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BEEFTV_DATA_DIR", dir)
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_CLIENT_ID", "client")
	t.Setenv("BEEFTV_CLIENT_TOKEN", "credential")
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	serve := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer credential" {
				t.Error("client credential lost after startup")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"data":{"ok":true}}`))
		}))
	}
	first := serve()
	if err := runtimeinfo.Write(dir, first.URL, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(context.Background(), "GET", "/ops", nil); err != nil {
		t.Fatal(err)
	}
	first.Close()
	next := serve()
	defer next.Close()
	if err := runtimeinfo.Write(dir, next.URL, "test"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.do(context.Background(), "GET", "/ops", nil); err != nil {
				t.Error(err)
			}
			if _, err := c.callBusiness(context.Background(), businessTool{Method: "GET", Path: "/assets"}, businessArgs{}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestClientFixedAddressDoesNotFollowRuntime(t *testing.T) {
	t.Setenv("BEEFTV_DATA_DIR", t.TempDir())
	t.Setenv("BEEFTV_BASE_URL", "http://127.0.0.1:43210")
	c, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	if err := runtimeinfo.Write(os.Getenv("BEEFTV_DATA_DIR"), "http://127.0.0.1:43211", "test"); err != nil {
		t.Fatal(err)
	}
	if c.currentBaseURL() != "http://127.0.0.1:43210" {
		t.Fatal("explicit endpoint changed")
	}
}
