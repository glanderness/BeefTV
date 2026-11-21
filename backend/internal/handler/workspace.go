package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

// workspaceBootstrap is the desktop bootstrap read model. Model config itself
// still comes from the provider port on the request.
type workspaceBootstrap interface {
	beefTVConnections
	WorkspaceOwner(string) (*model.User, error)
	PublicRuntimeLimits() (*platform.PublicRuntimeLimits, error)
	FeatureAvailability() (*platform.PublicFeatureAvailability, error)
	ReadLocalModelConfig() ([]byte, error)
	SaveLocalModelConfig([]byte) error
}

// RegisterWorkspaceRoutes exposes the desktop-first bootstrap contract. The
// workspace scope is injected by the runtime before the router is mounted, so
// this endpoint never reads a cookie or creates an AuthSession.
// configs is only the model-config fallback for requests that have no injected
// provider port; bootstrap owns identity, limits, features, and the connection.
func RegisterWorkspaceRoutes(r *gin.RouterGroup, bootstrap workspaceBootstrap) {
	r.GET("/workspace/bootstrap", func(c *gin.Context) {
		scope, err := CurrentWorkspace(c)
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		user, err := bootstrap.WorkspaceOwner(scope.ID)
		if err != nil {
			failService(c, err)
			return
		}
		publicUser := app.AuthUser{User: *user}
		// Desktop model configuration is persisted separately under the workspace
		// data directory. The bootstrap contract contains no account metadata.
		logicalModels := []app.PublicLogicalModel{}
		limits, err := bootstrap.PublicRuntimeLimits()
		if err != nil {
			failService(c, err)
			return
		}
		features, err := bootstrap.FeatureAvailability()
		if err != nil {
			failService(c, err)
			return
		}
		contract := LocalDesktopContract()
		ok(c, gin.H{
			"contractVersion": contract.Version,
			"profile":         contract.Profile,
			"capabilities":    contract.Capabilities,
			"workspace": gin.H{
				"id":      scope.ID,
				"name":    "本地工作区",
				"owner":   "local",
				"storage": "sqlite",
			},
			"user":          publicUser,
			"storageMode":   "local",
			"logicalModels": logicalModels,
			"runtimeLimits": limits,
			"features":      features,
		})
	})
	r.GET("/workspace/model-config", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, bootstrap); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		providerConfig := requestProviderConfig(c, bootstrap)
		if versioned, supportsVersioning := providerConfig.(VersionedProviderConfig); supportsVersioning {
			effective, health, err := versioned.LoadEffectiveModelConfig()
			if err != nil {
				failModelConfig(c, err)
				return
			}
			ok(c, gin.H{"config": redactModelConfig(c, bootstrap, effective.Config), "revision": effective.Revision, "health": health, "source": "builtin+local"})
			return
		}
		body, err := providerConfig.ReadLocalModelConfig()
		if err != nil {
			failModelConfig(c, err)
			return
		}
		if len(body) == 0 {
			ok(c, gin.H{"config": nil})
			return
		}
		var config map[string]any
		if err := json.Unmarshal(body, &config); err != nil {
			failModelConfig(c, workspace.ErrMalformedProviderConfig)
			return
		}
		ok(c, gin.H{"config": redactModelConfig(c, bootstrap, config)})
	})
	r.PUT("/workspace/model-config", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, bootstrap); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20))
		if err != nil {
			fail(c, http.StatusBadRequest, errors.New("本地模型配置读取失败"))
			return
		}
		var envelope struct {
			Config           json.RawMessage `json:"config"`
			ExpectedRevision *int64          `json:"expectedRevision"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Config) == 0 || string(envelope.Config) == "null" {
			fail(c, http.StatusBadRequest, errors.New("本地模型配置格式错误"))
			return
		}
		if _, external := externalBusiness(c); external && envelope.ExpectedRevision == nil {
			fail(c, http.StatusBadRequest, errors.New("修改模型配置需要 expectedRevision"))
			return
		}
		envelope.Config = preserveManagedModelConfig(c, bootstrap, envelope.Config)
		providerConfig := requestProviderConfig(c, bootstrap)
		if versioned, supportsVersioning := providerConfig.(VersionedProviderConfig); supportsVersioning && envelope.ExpectedRevision != nil {
			revision, err := versioned.SaveLocalModelConfigRevision(envelope.Config, *envelope.ExpectedRevision)
			if err != nil {
				failModelConfig(c, err)
				return
			}
			ok(c, gin.H{"saved": true, "revision": revision})
			return
		}
		if err := providerConfig.SaveLocalModelConfig(envelope.Config); err != nil {
			failModelConfig(c, err)
			return
		}
		ok(c, gin.H{"saved": true})
	})
	r.POST("/workspace/model-config/capability", func(c *gin.Context) {
		if _, err := workspaceForLocalRequest(c, bootstrap); err != nil {
			fail(c, http.StatusUnauthorized, err)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 512<<10))
		if err != nil {
			fail(c, http.StatusBadRequest, errors.New("模型能力草稿读取失败"))
			return
		}
		var draft modelcatalog.ModelCapabilityDraft
		if err := json.Unmarshal(body, &draft); err != nil {
			fail(c, http.StatusBadRequest, errors.New("模型能力草稿格式错误"))
			return
		}
		normalized, err := requestModelCapability(c, bootstrap).NormalizeModelCapabilityDraft(draft)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		ok(c, gin.H{
			"version":          normalized.Version,
			"text":             normalized.Text,
			"image":            normalized.Image,
			"video":            normalized.Video,
			"capabilityConfig": normalized,
		})
	})
}

func redactModelConfig(c *gin.Context, connections beefTVConnections, config map[string]any) map[string]any {
	if _, external := externalBusiness(c); external {
		// 标记要在清空密钥之前算出来，否则前端只能看到一对空字符串。
		config = markExternalCredentialState(redactExternalConfig(config), config)
	}
	managed := false
	if connection, err := requestBeefTV(c, connections); err == nil && connection != nil {
		managed = connection.HasManagedCredential()
		return connection.RedactConfig(config)
	}
	return beeftv.RedactConfig(config, managed)
}

func preserveManagedModelConfig(c *gin.Context, bootstrap workspaceBootstrap, raw json.RawMessage) json.RawMessage {
	var incoming map[string]any
	if err := json.Unmarshal(raw, &incoming); err != nil {
		return raw
	}
	existing := map[string]any{}
	providerConfig := requestProviderConfig(c, bootstrap)
	if versioned, ok := providerConfig.(VersionedProviderConfig); ok {
		if effective, _, err := versioned.LoadEffectiveModelConfig(); err == nil {
			existing = effective.Config
		}
	}
	managed := false
	if _, external := externalBusiness(c); external {
		preserveExternalConfigSecrets(incoming, existing)
	}
	if connection, err := requestBeefTV(c, bootstrap); err == nil && connection != nil {
		managed = connection.HasManagedCredential()
		connection.PreserveWrite(incoming, existing)
	} else {
		beeftv.PreserveManagedChannel(incoming, existing, managed)
	}
	encoded, err := json.Marshal(incoming)
	if err != nil {
		return raw
	}
	return encoded
}

func failModelConfig(c *gin.Context, err error) {
	switch {
	case errors.Is(err, workspace.ErrProviderConfigRevisionConflict):
		fail(c, http.StatusConflict, err)
	case errors.Is(err, workspace.ErrUnmatchedRedactedSecret):
		writeAppError(c, &app.AppError{
			Status:  http.StatusBadRequest,
			Code:    http.StatusBadRequest,
			Reason:  app.ErrorReason("provider_config_unmatched_secret"),
			Message: workspace.ErrUnmatchedRedactedSecret.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrInvalidProviderIdentity):
		writeAppError(c, &app.AppError{
			Status:  http.StatusBadRequest,
			Code:    http.StatusBadRequest,
			Reason:  app.ErrorReason("provider_config_invalid_identity"),
			Message: workspace.ErrInvalidProviderIdentity.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrProviderConfigInvalidSize):
		writeAppError(c, &app.AppError{
			Status:  http.StatusBadRequest,
			Code:    http.StatusBadRequest,
			Reason:  app.ReasonInvalidArgument,
			Message: workspace.ErrProviderConfigInvalidSize.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrProviderConfigNotObject) && !errors.Is(err, workspace.ErrMalformedProviderConfig):
		writeAppError(c, &app.AppError{
			Status:  http.StatusBadRequest,
			Code:    http.StatusBadRequest,
			Reason:  app.ReasonInvalidArgument,
			Message: workspace.ErrProviderConfigNotObject.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrProviderConfigLocked):
		writeAppError(c, &app.AppError{
			Status:  http.StatusServiceUnavailable,
			Code:    http.StatusServiceUnavailable,
			Reason:  app.ErrorReason("provider_config_locked"),
			Message: workspace.ErrProviderConfigLocked.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrProviderConfigKeyUnavailable):
		writeAppError(c, &app.AppError{
			Status:  http.StatusInternalServerError,
			Code:    http.StatusInternalServerError,
			Reason:  app.ErrorReason("provider_config_key_unavailable"),
			Message: workspace.ErrProviderConfigKeyUnavailable.Error(),
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrMalformedProviderConfig):
		writeAppError(c, &app.AppError{
			Status:  http.StatusInternalServerError,
			Code:    http.StatusInternalServerError,
			Reason:  app.ErrorReason("provider_config_corrupt"),
			Message: "本地模型配置文件损坏且无可用备份，请检查工作区目录或联系支持",
			Cause:   err,
		})
	case errors.Is(err, workspace.ErrProviderConfigPermission):
		writeAppError(c, &app.AppError{
			Status:  http.StatusInternalServerError,
			Code:    http.StatusInternalServerError,
			Reason:  app.ErrorReason("provider_config_permission"),
			Message: workspace.ErrProviderConfigPermission.Error(),
			Cause:   err,
		})
	default:
		failService(c, err)
	}
}

func workspaceForLocalRequest(c *gin.Context, connections beefTVConnections) (workspace.Context, error) {
	if scope, err := CurrentWorkspace(c); err == nil {
		return scope, nil
	}
	if connections.IsLocalMode() {
		return workspace.Context{ID: "local"}, nil
	}
	return workspace.Context{}, errors.New("本地工作区未初始化")
}
