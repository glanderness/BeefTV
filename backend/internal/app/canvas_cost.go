package app

import "infinite-canvas/backend/internal/modelcatalog"

// ModelCostPricing 返回本地模型配置里某个模型已保存的目录单价，供画布费用估算
// 使用。只读本地配置，不联网；没有价格的模型返回 false，界面显示「暂无价格」。
func (s *Service) ModelCostPricing(modelKey string) (map[string]any, bool) {
	snapshot, err := s.assistantConfig()
	if err != nil {
		return nil, false
	}
	return modelcatalog.LookupModelPricing(snapshot, modelKey)
}

func (s *operationSession) ModelCostPricing(modelKey string) (map[string]any, bool) {
	return s.service.ModelCostPricing(modelKey)
}
