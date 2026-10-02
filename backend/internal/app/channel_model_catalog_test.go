package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
)

func TestFetchChannelModelCatalogRejectsCredentialsWithoutNetwork(t *testing.T) {
	svc := &Service{}
	ctx := context.Background()
	actor := &model.User{ID: "user-1", Role: model.UserRoleUser}

	if _, err := svc.FetchChannelModelCatalog(ctx, nil, ChannelModelsRequest{BaseURL: "https://example.com/v1", APIKey: "k"}); err == nil {
		t.Fatal("anonymous catalog fetch accepted")
	}
	if _, err := svc.FetchChannelModelCatalog(ctx, actor, ChannelModelsRequest{BaseURL: "https://example.com/v1"}); err == nil || !strings.Contains(err.Error(), "API Key") {
		t.Fatalf("empty key error = %v", err)
	}
	if _, err := svc.FetchChannelModelCatalog(ctx, actor, ChannelModelsRequest{
		BaseURL: "https://enterprise.beefapi.com/v1", ChannelID: beefapi.ChannelID, CredentialRef: beefapi.CredentialRef,
	}); err == nil || !strings.Contains(err.Error(), "API Key") {
		t.Fatalf("missing BeefAPI credential error = %v", err)
	}
	if _, err := svc.FetchChannelModelCatalog(ctx, actor, ChannelModelsRequest{BaseURL: "http://127.0.0.1/v1", APIKey: "k"}); err == nil {
		t.Fatal("loopback catalog fetch accepted")
	} else {
		var auth *AuthError
		if !errors.As(err, &auth) {
			t.Fatalf("loopback error = %#v", err)
		}
	}
}

func TestFetchChannelModelCatalogGeminiLoopbackDoesNotLeaveTheHost(t *testing.T) {
	svc := &Service{}
	_, err := svc.FetchChannelModelCatalog(context.Background(), &model.User{ID: "user-1"}, ChannelModelsRequest{
		BaseURL: "http://127.0.0.1", APIKey: "k", APIFormat: "gemini",
	})
	if err == nil {
		t.Fatal("gemini loopback catalog fetch accepted")
	}
	var auth *AuthError
	if !errors.As(err, &auth) {
		t.Fatalf("gemini loopback error = %#v", err)
	}
}
