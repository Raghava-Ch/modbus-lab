export type TabId =
  | "connection"
  | "coils"
  | "discrete-inputs"
  | "holding-registers"
  | "input-registers"
  | "file-records"
  | "fifo-queue"
  | "diagnostics"
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
  { id: "connection", label: "Connection", icon: "plug", group: "settings", feature: "TCP/RTU setup" },
  { id: "coils", label: "Coils", icon: "toggle-left", group: "main", feature: "FC 01/05/15" },
  { id: "discrete-inputs", label: "Discrete Inputs", icon: "list", group: "main", feature: "FC 02" },
  { id: "holding-registers", label: "Holding Registers", icon: "database", group: "main", feature: "FC 03/06/16" },
  { id: "input-registers", label: "Input Registers", icon: "activity", group: "main", feature: "FC 04" },
  { id: "file-records", label: "File Records", icon: "file-text", group: "main", feature: "FC 20/21" },
  { id: "fifo-queue", label: "FIFO Queue", icon: "layers", group: "main", feature: "FC 24" },
  { id: "diagnostics", label: "Diagnostics", icon: "stethoscope", group: "main", feature: "FC 08" },
  { id: "custom-frame", label: "Custom Frame", icon: "file-text", group: "main", feature: "Raw PDU builder" },
  { id: "settings", label: "Settings", icon: "settings", group: "settings", feature: "App preferences" },
];

export const navigationState = $state({
  activeTab: "connection" as TabId,
});

export function setActiveTab(tab: TabId): void {
  navigationState.activeTab = tab;
}
