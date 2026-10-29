package canvasworkflow

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

const CharacterReplacementOperation = "video.replace-character"

const ReplacementPrepareOperation = "video.replacement-prepare"
const ReplacementFinishOperation = "video.replacement-finish"

func IsReplacementLocalOperation(id string) bool {
	return id == ReplacementPrepareOperation || id == ReplacementFinishOperation
}

func replacementLocalOperations() []Operation {
	return []Operation{
		{ID: ReplacementPrepareOperation, Version: 1, Name: "准备人物替换片段", OutputType: "text", Inputs: []InputPort{{"video", "原视频", "video", true, false}}, Fields: []Field{{Key: "maxSegments", Label: "片段上限", Type: "number"}}},
		{ID: ReplacementFinishOperation, Version: 1, Name: "恢复人物替换时间轴", OutputType: "video", Inputs: []InputPort{{"video", "原视频", "video", true, false}}, Fields: []Field{{Key: "manifest", Label: "已完成片段记录", Type: "string"}}},
	}
}

func ReplacementManifest(n Node) (ReplacementPlan, error) {
	var p ReplacementPlan
	text, _ := n.Config["manifest"].(string)
	if len(text) == 0 || len(text) > 256*1024 || json.Unmarshal([]byte(text), &p) != nil {
		return p, fmt.Errorf("人物替换片段记录无法读取")
	}
	return p, ValidatePreparedReplacementPlan(p, true)
}

func characterReplacementOperation() Operation {
	min, max := 1.0, 100.0
	return Operation{
		ID: CharacterReplacementOperation, Version: 1, Name: "单人物替换", OutputType: "video",
		Inputs: []InputPort{{"video", "原视频", "video", true, false}, {"character", "目标人物", "image", true, false}},
		Fields: []Field{
			{Key: "modelOption", Label: "模型（2.0 Fast）", Type: "select"},
			{Key: "vquality", Label: "生成清晰度", Type: "select", Options: []FieldOption{{Label: "720p", Value: "720p"}, {Label: "480p", Value: "480p"}}},
			{Key: "maxSegments", Label: "最多生成片段数（默认12）", Type: "number", Min: &min, Max: &max},
			{Key: "instructions", Label: "补充要求（可选）", Type: "textarea"},
		},
	}
}

func ValidateCharacterReplacement(n Node) error {
	if !strings.HasSuffix(strings.TrimSpace(fmt.Sprint(n.Config["modelOption"])), "::seedance-2.0-fast") {
		return fmt.Errorf("单人物替换请选择已启用的 Seedance 2.0 Fast 模型")
	}
	if value, ok := n.Config["maxSegments"]; ok {
		count := operationNumber(value)
		if math.IsNaN(count) || math.IsInf(count, 0) || count < 1 || count > 100 || math.Trunc(count) != count {
			return fmt.Errorf("最多生成片段数需为1到100的整数")
		}
	}
	if quality, ok := n.Config["vquality"].(string); ok && quality != "720p" && quality != "480p" {
		return fmt.Errorf("人物替换清晰度需为480p或720p")
	}
	if len([]rune(strings.TrimSpace(fmt.Sprint(n.Config["instructions"])))) > 2000 {
		return fmt.Errorf("补充要求不能超过2000字")
	}
	return nil
}
