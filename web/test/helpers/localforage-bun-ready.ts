import localforage from "localforage";

function allowMissingDriver(ready: () => Promise<void>) {
    return async () => {
        try {
            await ready();
        } catch (error) {
            if (error instanceof Error && error.message === "No available storage method found.") return;
            throw error;
        }
    };
}

const originalReady = localforage.ready.bind(localforage);
localforage.ready = allowMissingDriver(originalReady) as typeof localforage.ready;

const originalCreateInstance = localforage.createInstance.bind(localforage);
localforage.createInstance = ((options?: LocalForageOptions) => {
    const instance = originalCreateInstance(options);
    instance.ready = typeof instance.ready === "function"
        ? allowMissingDriver(instance.ready.bind(instance)) as typeof instance.ready
        : async () => undefined;
    return instance;
}) as typeof localforage.createInstance;
