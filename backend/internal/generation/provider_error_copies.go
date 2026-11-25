package generation

import "strings"

const unsentPreparationMarker = "本次尚未开始生成"

type categoryCopy struct {
	Reason string
	Action string
}

var categoryCopies = map[FailureCategory]categoryCopy{
	CategoryLocalDiskFull:         {Reason: "本地磁盘空间不足，无法保存数据", Action: "请清理 BeefTV 数据目录所在磁盘；已有生成结果请优先取回原任务，不要重复生成"},
	CategoryLocalCredential:       {Reason: "本地算力凭据读取失败", Action: "请检查工作区数据目录并重新连接算力账号；不要删除工作区密钥"},
	CategoryAuth:                  {Reason: "模型服务鉴权失败", Action: "请检查 API Key 后重试"},
	CategoryPermission:            {Reason: "当前渠道没有使用该模型的权限", Action: "请更换模型或检查渠道权限"},
	CategoryQuotaUser:             {Reason: "当前账号可用额度不足", Action: "请检查账号余额，补充额度或调整令牌、套餐额度后重试"},
	CategoryQuotaUpstream:         {Reason: "模型供应商拒绝了计费或额度相关请求", Action: "请到供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaUnknown:          {Reason: "模型服务拒绝了计费或额度相关请求", Action: "请到当前渠道或模型供应商核对账单与额度后，再决定是否重试"},
	CategoryQuotaLimit:            {Reason: "模型调用已达到设置的用量上限", Action: "请检查当前渠道的用量或预算限制，调整后再试"},
	CategoryModerationInput:       {Reason: "提示词或参考素材未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryModerationReference:   {Reason: "参考素材未通过内容安全审核", Action: "请检查并更换参考素材后重新生成"},
	CategoryModerationOutput:      {Reason: "生成结果未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"},
	CategoryInvalidParams:         {Reason: "模型不接受当前参数", Action: "请检查模型、尺寸、时长、格式或数量后重试"},
	CategoryLocalStorage:          {Reason: "本地数据库无法读写", Action: "请重启应用；若仍失败，请保留排查信息并联系支持，不要重复生成"},
	CategoryContextTooLong:        {Reason: "输入内容超出模型长度限制", Action: "请缩短提示词或减少参考内容后重试"},
	CategoryInputInaccessible:     {Reason: "参考素材无法读取", Action: "请检查素材后重试"},
	CategoryInputTooLarge:         {Reason: "参考素材过大", Action: "请压缩或更换素材后重试"},
	CategoryModelMissing:          {Reason: "当前模型或接口不可用", Action: "请检查模型名称和渠道配置"},
	CategoryThrottled:             {Reason: "请求过于频繁", Action: "请稍后再试"},
	CategoryConcurrency:           {Reason: "同时进行的生成过多", Action: "请等待已有任务完成后再试"},
	CategoryProviderUnavailable:   {Reason: "模型服务暂时不可用", Action: "请稍后重试"},
	CategoryReferenceUploadFailed: {Reason: "参考素材上传失败，" + unsentPreparationMarker, Action: "请检查对象存储配置和公开读取权限后重试"},
	CategoryNetwork:               {Reason: "网络连接失败", Action: "请检查网络并核对原任务状态后，再决定是否重新生成"},
	CategoryRequestNotSent:        {Reason: "未能连接服务，本次请求尚未提交", Action: "请检查网络或代理后重试"},
	CategoryTimeout:               {Reason: "模型服务响应超时", Action: "请稍后查询原任务，不要立即重新提交"},
	CategorySubmissionUncertain:   {Reason: "提交结果尚未确认，上游任务可能仍在执行", Action: "请先查询原任务状态，不要立即重新提交"},
	CategoryAsyncFailed:           {Reason: "生成任务没有完成", Action: "请查看详情后决定是否重试"},
	CategoryCancelled:             {Reason: "任务已取消", Action: "请核对原任务的结果与扣费状态"},
	CategoryPartialSuccess:        {Reason: "部分结果已生成，其余失败", Action: "请查看已有结果后再决定是否补做"},
	CategoryDownloadFailed:        {Reason: "生成结果下载失败", Action: "请稍后重新加载，不要立即重新提交"},
	CategoryDeliveryFailed:        {Reason: "视频已生成，但暂时无法取回", Action: "请联系支持恢复成片，恢复后点击「取回结果」；无需重新付费生成"},
	CategoryResultsMissing:        {Reason: "任务结束但没有可用结果", Action: "请查看详情后再决定是否重试"},
	CategoryMalformedResponse:     {Reason: "模型服务返回了无法解析的内容", Action: "请查看详情并核对原任务状态后，再决定是否重新生成"},
	CategoryUnknown:               {Reason: "生成失败", Action: "请查看详情后再决定是否重试"},
}

func (f Failure) displayCopy() (string, string) {
	if strings.TrimSpace(f.Reason) != "" {
		return strings.TrimSpace(f.Reason), strings.TrimSpace(f.Action)
	}
	copyText := categoryCopies[f.Category]
	if copyText.Reason == "" {
		copyText = categoryCopies[CategoryUnknown]
	}
	return copyText.Reason, copyText.Action
}

func (f Failure) debugIDLine() string {
	parts := make([]string, 0, 2)
	if id := sanitizeDebugID(f.TaskID); id != "" {
		parts = append(parts, "任务 "+id)
	}
	if id := sanitizeDebugID(f.RequestID); id != "" {
		parts = append(parts, "请求 "+id)
	}
	if len(parts) == 0 {
		return ""
	}
	return "排查编号：" + strings.Join(parts, " · ")
}

func joinSentences(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		part = strings.TrimRight(part, "。.;；")
		out = append(out, part)
	}
	if len(out) == 0 {
		return categoryCopies[CategoryUnknown].Reason + "。" + categoryCopies[CategoryUnknown].Action + "。"
	}
	if len(out) == 1 {
		return out[0]
	}
	return strings.Join(out, "。") + "。"
}
