import { describe, expect, test } from "bun:test";

import { getActiveUserScope, getActiveUserScopeEpoch, setActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, isUserScopeAbandonedError, UserScopeAbandonedError, userScopeMatches } from "@/lib/user-scope-guard";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

describe("user scope guard", () => {
    test("captures scope plus epoch and does not retain tokens", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            expect(captured.userScope).toBe("owner-a");
            expect(captured.epoch).toBe(getActiveUserScopeEpoch());
            expect(JSON.stringify(captured)).not.toContain("token");
            expect(JSON.stringify(captured)).not.toContain("Bearer");
            assertUserScope(captured);
        } finally {
            restore();
        }
    });

    test("A→B→A reuses the scope string but not the captured identity", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            setActiveUserScope("owner-b");
            expect(userScopeMatches(captured)).toBe(false);
            expect(() => assertUserScope(captured)).toThrow(UserScopeAbandonedError);
            setActiveUserScope("owner-a");
            expect(getActiveUserScope()).toBe("owner-a");
            expect(userScopeMatches(captured)).toBe(false);
            try {
                assertUserScope(captured);
                throw new Error("A→B→A should abandon the original capture");
            } catch (error) {
                expect(isUserScopeAbandonedError(error)).toBe(true);
            }
        } finally {
            restore();
        }
    });

    test("same-string rehydrate still bumps epoch", () => {
        const restore = switchScope("owner-a");
        try {
            const captured = captureUserScope();
            setActiveUserScope("owner-a");
            expect(getActiveUserScope()).toBe("owner-a");
            expect(userScopeMatches(captured)).toBe(false);
        } finally {
            restore();
        }
    });
});
