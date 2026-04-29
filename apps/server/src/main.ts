import "@shared-frontend/styles/base.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initializeTooltipOverlay } from "./lib/tooltip-overlay";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App mount target '#app' was not found.");
}

// Remove bootstrap HTML loader so it does not remain visible after mount.
target.innerHTML = "";

const app = mount(App, {
  target,
});

initializeTooltipOverlay();

export default app;
