import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";

import { useCanvasStarterNavigation } from "@/pages/canvas/use-canvas-starter-navigation";

const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";

function Harness() {
    const [searchParams, setSearchParams] = useState(new URLSearchParams(window.location.search));
    const [assistantCalls, setAssistantCalls] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const nodesRef = useRef([]);
    useCanvasStarterNavigation({
        projectLoaded: true,
        searchParams,
        setSearchParams: (next) => setSearchParams(new URLSearchParams(next as URLSearchParams)),
        containerRef,
        nodesRef,
        createNode: () => {},
        fitCanvasSelection: () => {},
        createDirectorShot: () => {},
        openAssistant: embedded ? undefined : () => setAssistantCalls((value) => value + 1),
    });
    return (
        <>
            <div ref={containerRef} style={{ width: 240, height: 180 }} />
            <output id="calls">{assistantCalls}</output>
            <output id="start">{searchParams.get("start") ?? ""}</output>
        </>
    );
}

createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
        <Harness />
    </MemoryRouter>,
);
