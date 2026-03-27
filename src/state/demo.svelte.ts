import { setConnectionStatus } from "./connection.svelte";
import { addLog } from "./logs.svelte";
import { setActiveTab, type TabId } from "./navigation.svelte";

export const demoState = $state({
  enabled: true,
  running: false,
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function jump(tab: TabId, message: string): Promise<void> {
  setActiveTab(tab);
  addLog("info", message);
  await wait(500);
}

export async function runDemoScript(): Promise<void> {
  if (demoState.running) {
    return;
  }

  demoState.running = true;
  addLog("info", "Demo script started.");

  setConnectionStatus("connecting");
  addLog("warn", "Attempting connection to demo endpoint.");
  await wait(700);

  setConnectionStatus("connected");
  addLog("info", "Connection established.");
  addLog("traffic", "TX 00 01 00 00 00 06 01 03 00 00 00 02");
  addLog("traffic", "RX 00 01 00 00 00 07 01 03 04 00 2A 00 2B");
  await wait(400);

  await jump("file-records", "File record request placeholder event generated.");
  addLog("traffic", "TX 00 02 00 00 00 09 01 14 06 00 01 00 00 00 02");
  await jump("fifo-queue", "FIFO queue polling placeholder event generated.");
  addLog("traffic", "RX 00 02 00 00 00 09 01 18 06 00 03 00 11 00 12");
  await jump("diagnostics", "Diagnostics probe placeholder event generated.");

  setConnectionStatus("disconnected");
  addLog("error", "Demo disconnected intentionally to showcase state transitions.");
  await jump("connection", "Demo script finished.");

  demoState.running = false;
}

export function toggleDemoMode(): void {
  demoState.enabled = !demoState.enabled;
  addLog("info", `Demo mode ${demoState.enabled ? "enabled" : "disabled"}.`);
}
