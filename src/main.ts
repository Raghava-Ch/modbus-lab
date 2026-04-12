import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App mount target '#app' was not found.");
}

// Remove bootstrap HTML loader so it does not remain visible after mount.
target.innerHTML = "";

const app = mount(App, {
  target,
});

export default app;
