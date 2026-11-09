import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles/app.css";
import { initTheme } from "./lib/theme.ts";
import { installLinkGuard } from "./lib/linkGuard.ts";
import { MainSurface } from "./surfaces/Main.tsx";
import { PickerSurface } from "./surfaces/Picker.tsx";
import { PopupSurface } from "./surfaces/Popup.tsx";
import { CobraBoxSurface } from "./surfaces/CobraBox.tsx";

// One page for every window; each picks its surface from ?surface= (src-tauri lib.rs).
initTheme();
installLinkGuard(window, openUrl);
const surface = new URLSearchParams(location.search).get("surface") ?? "main";
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    {surface === "picker" ? <PickerSurface /> : surface === "popup" ? <PopupSurface />
      : surface === "box" ? <CobraBoxSurface /> : <MainSurface />}
  </StrictMode>,
);
