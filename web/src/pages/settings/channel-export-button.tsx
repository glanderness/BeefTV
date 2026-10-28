import { App, Button, Dropdown } from "antd";
import copy from "copy-to-clipboard";
import { Download } from "lucide-react";
import { useState } from "react";
import { saveOwnedOrBrowserBlob } from "@/services/desktop-media-save";
import type { ModelChannel } from "@/stores/use-config-store";
import { canShareChannel, channelShareFileName, serializeChannel } from "./channel-share";

export function ChannelExportButton({ channel }: { channel: ModelChannel }) {
    const { message } = App.useApp();
    const [saving, setSaving] = useState(false);
    if (!canShareChannel(channel)) return null;

    const exportChannel = async (action: string) => {
        try {
            const json = serializeChannel(channel);
            if (action === "copy") {
                if (!copy(json)) throw new Error("复制失败，请使用导出文件");
                message.success("渠道 JSON 已复制，不含密钥和请求头");
                return;
            }
            setSaving(true);
            const result = await saveOwnedOrBrowserBlob(channelShareFileName(channel), new Blob([json], { type: "application/json;charset=utf-8" }));
            if (result === "saved") message.success("渠道配置已导出，不含密钥和请求头");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出渠道配置失败");
        } finally {
            setSaving(false);
        }
    };

    return <Dropdown trigger={["click"]} menu={{
        items: [{ key: "download", label: "导出文件" }, { key: "copy", label: "复制 JSON" }],
        onClick: ({ key }) => { void exportChannel(key); },
    }} disabled={saving}>
        <Button size="small" className="h-10 sm:h-8" icon={<Download className="size-3.5" />} loading={saving}>导出</Button>
    </Dropdown>;
}
