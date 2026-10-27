import { Select } from "antd";
import { currentLocale, setLocale, type Locale } from "./runtime";

const OPTIONS = [
    { value: "zh-CN", label: "中文" },
    { value: "en-US", label: "English" },
];

export function LanguageSwitch() {
    return <Select<Locale> size="small" value={currentLocale} options={OPTIONS} onChange={setLocale} style={{ width: 112 }} aria-label="Language" />;
}
