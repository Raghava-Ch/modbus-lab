<svelte:options runes={true} />

<script lang="ts">
  import { modbusAdapter } from "./lib/adapters/WebModbusAdapter";
  import AppShell from "./components/layout/AppShell.svelte";
  import { addLog } from "./state/logs.svelte";
  import { connectionState } from "./state/connection.svelte";
  import { applyBackendConnectionStatus } from "./state/connection.svelte";
  import { notifyError, notifyInfo } from "./state/notifications.svelte";
  import { initLayoutState } from "./state/layout.svelte";
  import { initSettingsState } from "./state/settings.svelte";

  let seeded = $state(false);
  let previousBackendStatus = $state<string | null>(null);
  let outageNotified = $state(false);

  function normalizeStatus(status: string | undefined): string {
    return (status ?? "").toLowerCase();
  }

  function isConnectedStatus(status: string): boolean {
    return status.startsWith("connected");
  }

  function isOutageStatus(status: string): boolean {
    return status === "reconnecting" || status === "disconnected";
  }

  function statusPollIntervalMs(connectedStableSince: number | null): number {
    if (connectionState.status !== "connected") {
      return 1000;
    }

    if (connectedStableSince == null) {
      return 5000;
    }

    const stableForMs = Date.now() - connectedStableSince;
    return stableForMs >= 30_000 ? 15_000 : 5000;
  }

  function maybeNotifyServerDown(nextStatusRaw: string | undefined, details?: string): void {
    const nextStatus = normalizeStatus(nextStatusRaw);
    const previousStatus = normalizeStatus(previousBackendStatus ?? undefined);
    const droppedFromConnected = isConnectedStatus(previousStatus) && isOutageStatus(nextStatus);

    if (droppedFromConnected && !outageNotified) {
      const suffix = details?.trim() ? ` (${details})` : "";
      notifyError(`Modbus server appears to be down${suffix}`);
      outageNotified = true;
    }

    if (isConnectedStatus(nextStatus)) {
      if (outageNotified) {
        notifyInfo("Reconnected to Modbus server.");
      }
      outageNotified = false;
    }

    previousBackendStatus = nextStatus;
  }

  $effect(() => {
    if (seeded) {
      return;
    }

    seeded = true;
    console.log("[App] Initializing ModbusLab Client...");
    addLog("info", "ModbusLab Client shell initialized.");

    // Initialize settings and layout state
    initSettingsState();
    initLayoutState();

    let statusPollTimer: ReturnType<typeof setTimeout> | undefined;
    let connectedStableSince: number | null = null;

    const setup = (): void => {
      console.log("[App] Starting status poll timer...");
      const statusPollTick = (): void => {
        try {
          const connected = modbusAdapter.isConnected();
          const currentStatus = connectionState.backendStatus;
          const status = connected 
            ? (currentStatus.startsWith("connected") ? currentStatus : (connectionState.protocol === "tcp" ? "connectedTcp" : "connectedSerialRtu")) 
            : "disconnected";
          
          maybeNotifyServerDown(status, connectionState.backendDetails);
          applyBackendConnectionStatus(status, connectionState.backendDetails);

          if (connectionState.status === "connected") {
            if (connectedStableSince == null) {
              connectedStableSince = Date.now();
            }
          } else {
            connectedStableSince = null;
          }
        } catch {
          connectedStableSince = null;
        } finally {
          const intervalMs = statusPollIntervalMs(connectedStableSince);
          statusPollTimer = setTimeout(statusPollTick, intervalMs);
        }
      };

      statusPollTimer = setTimeout(statusPollTick, 1000);
    };

    console.log("[App] Calling setup...");
    setup();

    return () => {
      console.log("[App] Cleanup called");
      if (statusPollTimer) {
        clearTimeout(statusPollTimer);
      }
    };
  });
</script>

<AppShell />