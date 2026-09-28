export function persistedTaskConstraintCopy(message: string) {
    for (const input of ["TaskTypeConstraint ratio first-frame", "TaskTypeConstraint duration", "TaskTypeConstraint ratio", "TaskTypeConstraint"]) {
        const copy = taskConstraintCopy(input)!;
        if (message.trim().startsWith(`${copy.reason}。${copy.action}`)) return copy;
    }
    return undefined;
}

export function taskConstraintCopy(message: string) {
    const text = message.toLowerCase();
    if (!text.includes("tasktypeconstraint")) return undefined;
    if (text.includes("ratio") && /first[-_]frame/.test(text)) return { reason: "首尾帧模式的画面比例需跟随首帧", action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式" };
    if (text.includes("duration")) return { reason: "当前任务模式不支持指定的视频时长", action: "编辑视频时请使用跟随原视频的时长；如需生成指定时长，请改用参考生成模式" };
    if (text.includes("ratio")) return { reason: "当前任务模式的画面比例需跟随输入素材", action: "请选择自适应比例后重新生成；如需指定比例，请改用参考生成模式" };
    return { reason: "生成参数与当前任务模式不兼容", action: "请检查所选模式；首尾帧和延长需跟随素材比例，编辑还需跟随原视频时长" };
}
