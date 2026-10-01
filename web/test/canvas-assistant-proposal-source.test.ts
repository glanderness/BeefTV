import { describe, expect, test } from "bun:test";

import { assistantProposalHasUnconfirmedEdits } from "@/pages/canvas/canvas-assistant-proposal-source";

describe("assistantProposalHasUnconfirmedEdits", () => {
    test("blocks confirmation while the canvas or model config is still dirty", () => {
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: true, modelConfigDirty: false, modelConfigStatus: "idle" })).toBe(true);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: true, modelConfigStatus: "saved" })).toBe(true);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "saving" })).toBe(true);
    });

    test("allows confirmation only after canvas and model config are idle or saved", () => {
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "idle" })).toBe(false);
        expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: "saved" })).toBe(false);
    });
});
