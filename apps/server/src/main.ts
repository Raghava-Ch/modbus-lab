import "@shared-frontend/styles/base.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");

if (!target) {
  throw new Error("App mount target '#app' was not found.");
}

target.innerHTML = "";

const app = mount(App, {
  target,
});

export default app;
