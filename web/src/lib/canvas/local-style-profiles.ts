import { serializeStyleProfile, type StyleProfileSnapshot } from "@/lib/canvas/style-profile";

export const LOCAL_STYLE_PROFILES_KEY = "canvas:style-library:profiles";

export type UserStyleProfile = {
    id: string;
    userId: string;
    name: string;
    description: string;
    coverUrl: string;
    tagsJson: string;
    profileJson: string;
    favorite: boolean;
    lastUsedAt?: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

type StyleStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StyleStorage | null {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
        return null;
    }
}

export function readLocalStyleProfiles(storage: StyleStorage | null = defaultStorage()): UserStyleProfile[] {
    if (!storage) return [];
    try {
        const parsed = JSON.parse(storage.getItem(LOCAL_STYLE_PROFILES_KEY) || "[]") as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((value): value is UserStyleProfile =>
                Boolean(
                    value &&
                    typeof value === "object" &&
                    typeof (value as UserStyleProfile).id === "string" &&
                    typeof (value as UserStyleProfile).profileJson === "string",
                ))
            : [];
    } catch {
        return [];
    }
}

export function persistLocalStyleProfiles(profiles: UserStyleProfile[], storage: StyleStorage | null = defaultStorage()) {
    if (!storage) return;
    try {
        storage.setItem(LOCAL_STYLE_PROFILES_KEY, JSON.stringify(profiles));
    } catch {
        // Private browsing or a full local quota should not make system styles unusable.
    }
}

export function saveLocalStyleProfileEntry(
    profiles: UserStyleProfile[],
    input: { id: string; profile: StyleProfileSnapshot; now?: string; apply?: boolean },
): { entity: UserStyleProfile; profiles: UserStyleProfile[] } {
    const now = input.now || new Date().toISOString();
    const existing = profiles.find((item) => item.id === input.id);
    const entity: UserStyleProfile = {
        id: input.id,
        userId: "local",
        name: input.profile.title || "未命名风格",
        description: input.profile.description || "",
        coverUrl: input.profile.coverUrl || "",
        tagsJson: JSON.stringify(input.profile.tags || []),
        profileJson: serializeStyleProfile(input.profile),
        favorite: existing?.favorite ?? false,
        lastUsedAt: input.apply ? now : existing?.lastUsedAt,
        revision: (existing?.revision || 0) + 1,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    return {
        entity,
        profiles: [entity, ...profiles.filter((item) => item.id !== input.id)],
    };
}

export function touchLocalStyleProfileUsed(
    profiles: UserStyleProfile[],
    id: string,
    now = new Date().toISOString(),
): UserStyleProfile[] {
    return profiles.map((entity) => (entity.id === id ? { ...entity, lastUsedAt: now, updatedAt: now } : entity));
}

export type LocalStyleProfileStore = {
    getAll: () => UserStyleProfile[];
    reload: () => UserStyleProfile[];
    save: (input: { id: string; profile: StyleProfileSnapshot; now?: string; apply?: boolean }) => { entity: UserStyleProfile; profiles: UserStyleProfile[] };
    setFavorite: (id: string, favorite: boolean, now?: string) => UserStyleProfile[];
    remove: (id: string) => UserStyleProfile[];
    markUsed: (id: string, now?: string) => UserStyleProfile[];
};

/**
 * Synchronous store for local user style profiles so save -> immediate apply
 * (`保存并应用`) always transforms the freshly committed list instead of a
 * stale React render closure.
 */
export function createLocalStyleProfileStore(storage: StyleStorage | null = defaultStorage()): LocalStyleProfileStore {
    let current = readLocalStyleProfiles(storage);

    const commit = (next: UserStyleProfile[]) => {
        current = next;
        persistLocalStyleProfiles(next, storage);
        return next;
    };

    return {
        getAll: () => current,
        reload: () => {
            current = readLocalStyleProfiles(storage);
            return current;
        },
        save: (input) => {
            const saved = saveLocalStyleProfileEntry(current, input);
            commit(saved.profiles);
            return saved;
        },
        setFavorite: (id, favorite, now = new Date().toISOString()) =>
            commit(current.map((item) => (item.id === id ? { ...item, favorite, updatedAt: now } : item))),
        remove: (id) => commit(current.filter((item) => item.id !== id)),
        markUsed: (id, now = new Date().toISOString()) => commit(touchLocalStyleProfileUsed(current, id, now)),
    };
}
