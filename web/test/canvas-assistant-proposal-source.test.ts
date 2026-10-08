import { describe, expect, test } from "bun:test";

import { assistantProposalHasUnconfirmedEdits, assistantProposalUnconfirmedReason } from "@/pages/canvas/canvas-assistant-proposal-source";

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

    test("separates canvas edits, model edits and model save/read failure without relaxing the gate", () => {
        expect(assistantProposalUnconfirmedReason({ canvasDirty: true, modelConfigDirty: true, modelConfigStatus: "saving" })).toBe("canvas-dirty");
        expect(assistantProposalUnconfirmedReason({ canvasDirty: false, modelConfigDirty: true, modelConfigStatus: "saved" })).toBe("model-dirty");
        for (const status of ["saving", "hydrating", "error"]) {
            expect(assistantProposalUnconfirmedReason({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: status })).toBe("model-status");
            expect(assistantProposalHasUnconfirmedEdits({ canvasDirty: false, modelConfigDirty: false, modelConfigStatus: status })).toBe(true);
        }
    });
});
