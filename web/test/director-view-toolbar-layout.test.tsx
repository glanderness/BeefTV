import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorViewToolbar } from "@/components/canvas/director/director-view-toolbar";

describe("导演台取景层级", () => {
    test("导演/机位是主操作，五个正交轴向收在可发现的菜单", () => {
        const markup = renderToStaticMarkup(<DirectorViewToolbar viewMode="free" onViewModeChange={() => {}} />);
        expect(markup).toContain("导演视角");
        expect(markup).toContain("机位视角");
        expect(markup).toContain('aria-label="其他视角"');
        expect(markup).not.toContain(">TOP</button>");
        expect(markup).not.toContain(">FRONT</button>");
    });
});
