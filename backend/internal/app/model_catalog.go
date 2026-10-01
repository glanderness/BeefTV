package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

// ModelCatalogSource 决定 ModelCatalogResponse 中哪一个集合具有语义。
// frontend 与 system 的数据形状互斥，调用方不能把缺失集合解释成空目录。
type ModelCatalogSource string

const (
	// ModelCatalogSourceFrontend 表示目录由前台逻辑模型组成。
	ModelCatalogSourceFrontend ModelCatalogSource = "frontend"
	// ModelCatalogSourceSystem 表示目录由脱敏后的系统渠道与渠道模型组成。
	ModelCatalogSourceSystem ModelCatalogSource = "system"
)

// ModelCatalogResponse 是创作端模型选择的统一读模型。
// Source=frontend 时读取 Models；Source=system 时读取 Channels。
// 两个集合都始终序列化为数组：空目录必须发 []，缺字段会被前端判成畸形响应。
type ModelCatalogResponse struct {
	Source   ModelCatalogSource     `json:"source"`
	Models   []PublicLogicalModel   `json:"models"`
	Channels []PublicChannelCatalog `json:"channels"`
}

// ModelCatalog 按功能开关返回互斥的数据形状：frontend 使用 Models，system 使用 Channels。
// 系统渠道目录只负责安全发布可解释的读模型。
func (s *Service) ModelCatalog(intent *ModelRequestIntent) (*ModelCatalogResponse, error) {
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return nil, err
	}

	// 两个集合都初始化成非 nil 空切片：空目录要发 []，不能因为“没有模型”而丢掉字段。
	response := &ModelCatalogResponse{Models: []PublicLogicalModel{}, Channels: []PublicChannelCatalog{}}
	if frontendEnabled {
		models, err := s.PublicLogicalModels(intent)
		if err != nil {
			return nil, err
		}
		response.Source = ModelCatalogSourceFrontend
		response.Models = append(response.Models, models...)
		return response, nil
	}

	channels, err := s.publicSystemChannelCatalog(intent)
	if err != nil {
		return nil, err
	}
	response.Source = ModelCatalogSourceSystem
	response.Channels = append(response.Channels, channels...)
	return response, nil
}

// publicSystemChannelCatalog 组装普通用户可见的系统渠道读模型，不暴露密钥、Base URL 等执行凭证。
// 这是读展示路径：单个损坏模型被隔离并记录诊断；仓储查询失败仍整体返回错误，避免伪装成空目录。
func (s *Service) publicSystemChannelCatalog(intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	channels, err := s.repo.SystemChannels(true)
	if err != nil {
		return nil, err
	}
	return modelcatalog.PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return s.repo.ChannelModels(channelID, false)
	}, intent)
}

func (s *Service) sanitizeChannelModel(cm *model.ChannelModel) (PublicChannelModel, error) {
	return modelcatalog.SanitizeChannelModel(cm)
}

func (s *Service) channelModelMatchesIntent(cm *model.ChannelModel, intent *ModelRequestIntent) (bool, error) {
	return modelcatalog.ChannelModelMatchesIntent(cm, intent)
}
