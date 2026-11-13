import { useState } from "react";
import { Plus } from "lucide-react";
import { IconButton, iconButtonVariants } from "@/components/ui/base/buttons";
import { cn } from "@/lib/utils";

export function IconButtonMatrix() {
    const [clicks, setClicks] = useState(0);
    const [submits, setSubmits] = useState(0);
    return (
        <section aria-label="IconButton matrix" data-testid="icon-button-matrix" style={{ display: "grid", gap: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 76px)", gap: 12 }}>
                {(["ghost", "default", "outline", "solid", "danger"] as const).flatMap((variant) =>
                    (["xs", "sm", "default", "lg"] as const).map((size) => (
                        <div key={`${variant}/${size}`} style={{ display: "grid", gap: 4 }}>
                            <span>
                                {variant}/{size}
                            </span>
                            <IconButton data-testid={`${variant}/${size}`} variant={variant} size={size} icon={Plus} aria-label={`${variant}/${size}`} />
                        </div>
                    )),
                )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                <IconButton icon={Plus} aria-label="override layout" className="grid items-start justify-start" />
                <IconButton icon={Plus} aria-label="override size" className="size-10 [&_svg]:size-5" />
                <IconButton icon={Plus} aria-label="override radius" className="rounded-full" />
                <IconButton icon={Plus} aria-label="override color" className="text-status-error hover:text-foreground" />
                <IconButton icon={Plus} aria-label="override hover" className="hover:text-white hover:bg-transparent" />
                <IconButton icon={Plus} aria-label="override focus" className="focus-visible:ring-1" />
                <IconButton icon={Plus} aria-label="override disabled" disabled className="disabled:opacity-50" />
                <IconButton icon={Plus} aria-label="decorative active" active />
                <IconButton icon={Plus} aria-label="composed variants" variant="solid" size="xs" className={iconButtonVariants({ variant: "danger", size: "lg" })} />
                <IconButton icon={Plus} aria-label="null variants" variant={null} size={null} />
                <button type="button" aria-label="exported variants" className={cn(iconButtonVariants({ variant: "outline", size: "sm" }), "size-10")}>
                    <Plus aria-hidden />
                </button>
                {new URLSearchParams(location.search).get("iconPrefix") === "1" && (
                    <button type="button" aria-label="prepended variants" className={cn("grid items-start justify-start", iconButtonVariants())}>
                        <Plus aria-hidden />
                    </button>
                )}
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    setSubmits((value) => value + 1);
                }}
                style={{ display: "flex", gap: 16 }}
            >
                <IconButton icon={Plus} aria-label="matrix count" onClick={() => setClicks((value) => value + 1)} />
                <IconButton icon={Plus} aria-label="matrix disabled" disabled onClick={() => setClicks((value) => value + 1)} />
                <IconButton icon={Plus} aria-label="matrix loading" loading onClick={() => setClicks((value) => value + 1)} />
                <IconButton icon={Plus} aria-label="explicit submit" type="submit" />
                <output aria-label="matrix clicks" role="status">
                    {clicks}
                </output>
                <output aria-label="matrix submits" role="status">
                    {submits}
                </output>
            </form>
        </section>
    );
}
