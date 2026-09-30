import { useEffect, useState } from "react";

import { DESKTOP_UPDATE_CHECK_INTERVAL_MS, getSharedDesktopUpdateController, type DesktopUpdateController, type DesktopUpdateSnapshot } from "@/services/desktop-update";

export function useDesktopUpdateBootstrap(controller: DesktopUpdateController = getSharedDesktopUpdateController()) {
    useEffect(() => {
        void controller.start();
        const id = window.setInterval(() => void controller.check(), DESKTOP_UPDATE_CHECK_INTERVAL_MS);
        return () => window.clearInterval(id);
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
        downloadAndInstall: controller.downloadAndInstall,
        retry: controller.retry,
    };
}
