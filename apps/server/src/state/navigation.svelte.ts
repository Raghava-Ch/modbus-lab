export type TabId =
  | "listener"
  | "coils"
  | "discrete-inputs"
  | "holding-registers"
  | "input-registers"
  | "file-records"
  | "fifo-queue"
  | "traffic"
  | "custom-frame"
  | "settings";

export type TabIcon =
  | "plug"
  | "toggle-left"
  | "list"
  | "database"
  | "activity"
  | "file-text"
  | "layers"
  | "stethoscope"
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
  { id: "file-records", label: "File Records", icon: "file-text", group: "main", feature: "FC 20/21 (Not Supported)" },
  { id: "fifo-queue", label: "FIFO Queue", icon: "layers", group: "main", feature: "FC 24 (Not Supported)" },
  { id: "traffic", label: "Traffic", icon: "stethoscope", group: "main", feature: "Request/error analytics" },
  { id: "custom-frame", label: "Custom Frame", icon: "file-text", group: "main", feature: "Raw PDU builder" },
  { id: "settings", label: "Settings", icon: "settings", group: "settings", feature: "Server defaults & preferences" },
];

export const navigationState = $state({
  activeTab: "listener" as TabId,
});

export function setActiveTab(tab: TabId): void {
  navigationState.activeTab = tab;
}
