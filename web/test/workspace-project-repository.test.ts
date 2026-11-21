import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as localWorkspaceRepository from "@/services/local-workspace-repository";
import { createWorkspaceCanvasProject, deleteWorkspaceCanvasProjects } from "@/services/workspace-project-repository";

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
});

describe("workspace project repository", () => {
    test("createWorkspaceCanvasProject delegates directly to createLocalCanvasProject", async () => {
        const spy = spyOn(localWorkspaceRepository, "createLocalCanvasProject").mockResolvedValue({ id: "canvas-new-1" });
        spies.push(spy);

        const created = await createWorkspaceCanvasProject("新项目", "domain-1", { nodes: [] }, "ws-root-1");
        expect(created).toStrictEqual({ id: "canvas-new-1" });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith("新项目", "domain-1", { nodes: [] }, "ws-root-1");
    });

    test("deleteWorkspaceCanvasProjects delegates directly to deleteLocalCanvasProjects", async () => {
        const spy = spyOn(localWorkspaceRepository, "deleteLocalCanvasProjects").mockResolvedValue({ deleted: 2 });
        spies.push(spy);

        const result = await deleteWorkspaceCanvasProjects(["canvas-1", "canvas-2"]);
        expect(result).toEqual({ deleted: 2 });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(["canvas-1", "canvas-2"]);
    });
});
