package generation

import "strings"

func persistedTaskConstraintCopy(message string) (categoryCopy, bool) {
	for _, input := range []string{"TaskTypeConstraint ratio first-frame", "TaskTypeConstraint duration", "TaskTypeConstraint ratio", "TaskTypeConstraint"} {
		copy, _ := taskConstraintCopy(input)
		if strings.HasPrefix(strings.TrimSpace(message), copy.Reason+"。"+copy.Action) {
			return copy, true
		}
	}
	return categoryCopy{}, false
}

func taskConstraintCopy(message string) (categoryCopy, bool) {
	m := strings.ToLower(message)
	if !strings.Contains(m, "tasktypeconstraint") {
		return categoryCopy{}, false
	}
	if strings.Contains(m, "ratio") && (strings.Contains(m, "first-frame") || strings.Contains(m, "first_frame")) {
		return categoryCopy{Reason: "首尾帧模式的画面比例需跟随首帧", Action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式"}, true
	}
	if strings.Contains(m, "duration") {
		return categoryCopy{Reason: "当前任务模式不支持指定的视频时长", Action: "编辑视频时请使用跟随原视频的时长；如需生成指定时长，请改用参考生成模式"}, true
	}
	if strings.Contains(m, "ratio") {
		return categoryCopy{Reason: "当前任务模式的画面比例需跟随输入素材", Action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式"}, true
	}
	return categoryCopy{Reason: "生成参数与当前任务模式不兼容", Action: "请检查所选模式；首尾帧和延长需跟随素材比例，编辑还需跟随原视频时长"}, true
}
