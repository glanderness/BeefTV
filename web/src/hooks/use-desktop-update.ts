import { useEffect, useState } from "react";

import { getSharedDesktopUpdateController, type DesktopUpdateController, type DesktopUpdateSnapshot } from "@/services/desktop-update";

export function useDesktopUpdateBootstrap(controller: DesktopUpdateController = getSharedDesktopUpdateController()) {
    useEffect(() => {
        void controller.start();
    }, [controller]);
}

export function useDesktopUpdate(controller: DesktopUpdateController = getSharedDesktopUpdateController()) {
    const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot>(() => controller.getSnapshot());

    useEffect(() => {
        const unsubscribe = controller.subscribe(setSnapshot);
        void controller.start();
        return unsubscribe;
    }, [controller]);

    return {
        snapshot,
        state: snapshot.state,
        persistBusy: snapshot.persistBusy,
        actionBusy: snapshot.actionBusy,
        runtime: snapshot.runtime,
        download: controller.download,
        install: controller.install,
        retry: controller.retry,
    };
}
