import { expect, test } from "bun:test";
import fixtures from "../../fixtures/moderation-errors.json";
import { explainGenerationError, generationFailureMetadata, shouldBlockAutomaticRetry } from "../src/lib/generation-error";

for (const fixture of fixtures) {
    test(`moderation raw, wrapped, message-only and persisted: ${fixture.code}`, () => {
        const requestId = "req_moderation_123";
        const inputs = [
            { error: { code: fixture.code, message: fixture.message }, request_id: requestId },
            { error: { code: fixture.code } },
            fixture.message,
            ...["invalid_request_error", "upstream_error", "400"].map(code => ({ status: 400, data: { error: { code, message: fixture.message }, request_id: requestId } })),
        ];
        for (const input of inputs) {
            const first = explainGenerationError(input);
            const persisted = explainGenerationError(generationFailureMetadata(input, "private prompt").errorDetails);
            for (const f of [first, persisted]) {
                expect(f.category).toBe(fixture.category);
                expect(f.reason).toBe(fixture.reason);
                expect(f.action).toBe(fixture.action);
                expect(f.moderation).toBe(true);
                expect(f.blockAutomaticRetry).toBe(true);
                expect(f.retryable).toBe(false);
                expect(f.message).not.toContain("private prompt");
            }
            expect(persisted.requestId).toBe(first.requestId);
            expect(shouldBlockAutomaticRetry(input)).toBe(true);
        }
        const emitted = `${fixture.reason}。${fixture.action}。排查编号：请求 req_moderation_123。`;
        expect(explainGenerationError(emitted).message).toBe(emitted);
        expect(explainGenerationError({code: fixture.category, message: emitted}).message).toBe(emitted);
        expect(explainGenerationError(fixture.message + " Request id: req_moderation_123").requestId).toBe(requestId);
    });
}

test("specific provider codes outrank incidental safety text; request echoes are not evidence", () => {
    expect(explainGenerationError("The request failed because the output may contain sensitive information.").category).toBe("moderation_output");
    expect(explainGenerationError({error:{code:"invalid_api_key",message:fixtures[0].message}}).category).toBe("auth");
    expect(explainGenerationError({error:{code:"invalid_request_error",message:"invalid parameter"},prompt:fixtures[0].message}).category).toBe("invalid_params");
    expect(explainGenerationError({error:{message:"opaque",code:"upstream_error"},input:fixtures[0].message}).category).toBe("unknown");
    expect(explainGenerationError({error:{message:"opaque",code:"invalid_api_key"},prompt:"真人形象"}).category).toBe("auth");
    const f = explainGenerationError({error:{code:"invalid_request_error",message:"Rate limit exceeded"}});
    expect(f.category).toBe("throttled");
});
