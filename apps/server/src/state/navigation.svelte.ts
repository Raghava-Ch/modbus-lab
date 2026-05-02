export type TabId =
  | "listener"
  | "coils"
  | "discrete-inputs"
  | "holding-registers"
  | "input-registers"
  | "file-records"
  | "fifo-queue"
  | "traffic"
  | "diagnostics"
  | "ibus"
  | "settings";

export type TabIcon =
  | "plug"
  | "toggle-left"
  | "list"
  | "database"
  | "activity"
  | "file-text"
  | "layers"
  | "traffic"
  | "stethoscope"
  | "compass"
  | "settings";

export interface TabDef {
  id: TabId;
  label: string;
  icon: TabIcon;
  group: "main" | "settings";
  feature: string;
}

export const tabDefs: TabDef[] = [
  { id: "listener", label: "Listener", icon: "plug", group: "main", feature: "Start/stop server and manage clients" },
  { id: "coils", label: "Coils", icon: "toggle-left", group: "main", feature: "FC 01/05/15 (Read/Write)" },
  { id: "discrete-inputs", label: "Discrete Inputs", icon: "list", group: "main", feature: "FC 02 (Read-Only)" },
  { id: "holding-registers", label: "Holding Registers", icon: "database", group: "main", feature: "FC 03/06/16 (Read/Write)" },
  { id: "input-registers", label: "Input Registers", icon: "activity", group: "main", feature: "FC 04 (Read-Only)" },
  { id: "file-records", label: "File Records", icon: "file-text", group: "main", feature: "FC 20/21 (Read/Write)" },
  { id: "fifo-queue", label: "FIFO Queue", icon: "layers", group: "main", feature: "FC 24 (Read FIFO Queue)" },
  { id: "traffic", label: "Traffic", icon: "traffic", group: "main", feature: "Request/error analytics" },
  { id: "diagnostics", label: "Diagnostics", icon: "stethoscope", group: "main", feature: "FC07/08/11/12/17/43 tools" },
  { id: "ibus", label: "iBus", icon: "compass", group: "main", feature: "iBus v1.1 publisher" },
  { id: "settings", label: "Settings", icon: "settings", group: "settings", feature: "Server defaults & preferences" },
];

export const navigationState = $state({
  activeTab: "listener" as TabId,
});

export function setActiveTab(tab: TabId): void {
  navigationState.activeTab = tab;
}
