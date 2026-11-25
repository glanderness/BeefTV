import { Input } from "antd";
import { Search } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import "./choice-browser.css";

export type BrowserChoice = {
    value: string;
    label: string;
    subtitle?: string;
    vendor?: string;
    group?: string;
    groupHint?: string;
    description?: string;
    hint?: string;
    searchText?: string;
    disabled?: boolean;
    details: Array<{ label: string; value: ReactNode }>;
};

type ChoiceGroup = {
    name: string;
    hint?: string;
    options: BrowserChoice[];
};

function groupChoices(options: BrowserChoice[]): ChoiceGroup[] | null {
    if (!options.some((option) => option.group)) return null;
    const groups: ChoiceGroup[] = [];
    const byName = new Map<string, ChoiceGroup>();
    for (const option of options) {
        const name = option.group || "其他";
        let group = byName.get(name);
        if (!group) {
            group = { name, hint: option.groupHint, options: [] };
            byName.set(name, group);
            groups.push(group);
        }
        group.options.push(option);
    }
    return groups;
}

/** A controlled form field: searching never changes the selected value. */
export function ChoiceBrowser({
    value,
    onChange,
    options,
    label,
    placeholder = "搜索名称、来源或请求路径",
    loading = false,
    error = "",
    disabled = false,
    id,
    ...aria
}: {
    value?: string;
    onChange?: (value: string) => void;
    options: BrowserChoice[];
    label: string;
    placeholder?: string;
    loading?: boolean;
    error?: string;
    disabled?: boolean;
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
}) {
    const name = useId();
    const [query, setQuery] = useState("");
    const selected = options.find((option) => option.value === value);
    const normalizedQuery = query.trim().toLowerCase();
    const visible = options.filter((option) =>
        [option.label, option.subtitle, option.vendor, option.group, option.description, option.searchText]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery),
    );
    const grouped = groupChoices(visible);
    const unavailable = disabled || loading || Boolean(error);

    const renderOption = (option: BrowserChoice) => (
        <label key={option.value} className="choice-browser-option" data-selected={option.value === value}>
            <span className="choice-browser-main">
                <strong>{option.label}</strong>
                <span title={option.subtitle}>{option.subtitle}</span>
            </span>
            <span className="choice-browser-vendor" title={option.vendor}>
                {option.vendor}
            </span>
            <input type="radio" name={name} value={option.value} checked={option.value === value} disabled={unavailable || option.disabled} onChange={() => onChange?.(option.value)} />
        </label>
    );

    return (
        <div className="choice-browser">
            <Input id={id} {...aria} allowClear aria-label={`搜索${label}`} disabled={unavailable} prefix={<Search className="size-3.5" aria-hidden="true" />} placeholder={placeholder} value={query} onChange={(event) => setQuery(event.target.value)} />
            {loading || error || !options.length ? (
                <div className="choice-browser-state" role={error ? "alert" : "status"}>
                    {loading ? "正在读取可选项…" : error || "暂无可用选项"}
                </div>
            ) : (
                <div className="choice-browser-panels">
                    <div className="choice-browser-list" role="radiogroup" aria-label={label}>
                        {grouped
                            ? grouped.map((group) => (
                                  <div key={group.name} className="choice-browser-group">
                                      <div className="choice-browser-group-header" role="presentation">
                                          <span>{group.name}</span>
                                          {group.hint ? <small>{group.hint}</small> : null}
                                      </div>
                                      {group.options.map(renderOption)}
                                  </div>
                              ))
                            : visible.map(renderOption)}
                        {!visible.length && (
                            <div className="choice-browser-state" role="status">
                                没有匹配的选项
                            </div>
                        )}
                    </div>
                    <div className="choice-browser-detail" aria-live="polite">
                        <span>当前选择</span>
                        {selected ? (
                            <>
                                <strong>{selected.label}</strong>
                                {selected.description ? <p className="choice-browser-description">{selected.description}</p> : null}
                                <dl>
                                    {selected.details.map((detail) => (
                                        <div key={detail.label}>
                                            <dt>{detail.label}</dt>
                                            <dd>{detail.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                                {selected.hint ? <p className="choice-browser-hint">{selected.hint}</p> : null}
                            </>
                        ) : (
                            <p>{value ? `当前配置 ${value} 不在可用目录中，请重新选择。` : "选择左侧选项查看详情与接入说明"}</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
