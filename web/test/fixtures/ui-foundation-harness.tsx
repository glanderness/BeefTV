import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import "@/styles/beeftv-local-overrides.css";
import "@/styles/workspace-product.css";
import UIFoundationLab from "@/pages/dev/ui-foundation-lab";
import { IconButtonMatrix } from "./icon-button-matrix";

// Match application.tsx's current bootstrap; a token-only fixture uses a different font.
document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(<UIFoundationLab>{new URLSearchParams(location.search).get("iconMatrix") === "1" ? <IconButtonMatrix /> : null}</UIFoundationLab>);
