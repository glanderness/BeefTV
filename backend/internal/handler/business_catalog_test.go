package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestBusinessCatalogProjectsQueriesAndTrustedTaskFields(t *testing.T) {
	catalog := NewBusinessCatalog(gin.RoutesInfo{
		{Method: "GET", Path: "/api/projects"},
		{Method: "GET", Path: "/api/projects/:id/chapter-apply-receipts"},
		{Method: "POST", Path: "/api/tasks"},
		{Method: "GET", Path: "/api/assistant/runtime/turns/:id"},
	})
	if len(catalog.Tools) != 3 {
		t.Fatalf("sensitive route discovered: %#v", catalog.Tools)
	}
	for _, tool := range catalog.Tools {
		props := tool.Params["properties"].(map[string]any)
		if tool.Path == "/projects" {
			query := props["query"].(map[string]any)["properties"].(map[string]any)
			if query["pageSize"].(map[string]any)["default"] != "50" {
				t.Fatal("actual handler pagination default absent", query)
			}
		}
		if tool.Path == "/projects/:id/chapter-apply-receipts" {
			query := props["query"].(map[string]any)["properties"].(map[string]any)
			field := query["taskIds"].(map[string]any)
			if field["description"] == "" || field["x-value-schema"] == nil {
				t.Fatal("OpenAPI query metadata not projected", query)
			}
		}
		if tool.Path == "/tasks" {
			raw, _ := json.Marshal(props["body"])
			if strings.Contains(strings.ToLower(string(raw)), "admission") || !tool.SubmitsGeneration || tool.Cost != "selected-channel" {
				t.Fatal("trusted admission exposed or cost missing", string(raw), tool)
			}
		}
	}
	if _, ok := catalog.Match("GET", "/api/projects/../chapter-apply-receipts"); ok {
		t.Fatal("unsafe path accepted")
	}
}

func TestBusinessCatalogOutboundPostsRequireWriteClient(t *testing.T) {
	routes := gin.RoutesInfo{}
	for _, path := range []string{"/ai/models", "/runninghub/workflow-info", "/runninghub/app-info"} {
		routes = append(routes, gin.RouteInfo{Method: "POST", Path: "/api" + path})
	}
	catalog := NewBusinessCatalog(routes)
	if len(catalog.Tools) != 3 {
		t.Fatal("outbound tools missing")
	}
	for _, tool := range catalog.Tools {
		if tool.ReadOnly {
			t.Fatal("outbound POST marked read-only", tool.Path)
		}
	}
}
