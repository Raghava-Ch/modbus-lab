export const layoutState = $state({
  navCollapsed: false,
  statusCompact: false,
  logCollapsed: false,
  logHeight: 220,
  logPanelView: "logs" as "logs" | "details",
  mobileLogOpen: false,
});

const NAV_KEY = "Modbus-Lab.navCollapsed";
const LOG_KEY = "Modbus-Lab.logCollapsed";
const LOG_HEIGHT_KEY = "Modbus-Lab.logHeight";
const LOG_VIEW_KEY = "Modbus-Lab.logPanelView";
const LOG_HEIGHT_MIN = 140;
const LOG_HEIGHT_MAX = 460;

export function initLayoutState(): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  layoutState.navCollapsed = localStorage.getItem(NAV_KEY) === "1";
  layoutState.logCollapsed = localStorage.getItem(LOG_KEY) === "1";
  const savedView = localStorage.getItem(LOG_VIEW_KEY);
  if (savedView === "logs" || savedView === "details") {
    layoutState.logPanelView = savedView;
  }

  const savedHeight = Number(localStorage.getItem(LOG_HEIGHT_KEY));
  if (Number.isFinite(savedHeight) && savedHeight > 0) {
    layoutState.logHeight = Math.min(LOG_HEIGHT_MAX, Math.max(LOG_HEIGHT_MIN, savedHeight));
  }
}

function persist(key: string, value: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(key, value ? "1" : "0");
}

export function toggleNavCollapsed(): void {
  layoutState.navCollapsed = !layoutState.navCollapsed;
  persist(NAV_KEY, layoutState.navCollapsed);
}

export function toggleStatusCompact(): void {
  layoutState.statusCompact = !layoutState.statusCompact;
}

export function toggleLogCollapsed(): void {
  layoutState.logCollapsed = !layoutState.logCollapsed;
  persist(LOG_KEY, layoutState.logCollapsed);
}

export function setLogHeight(height: number): void {
  const clamped = Math.min(LOG_HEIGHT_MAX, Math.max(LOG_HEIGHT_MIN, Math.round(height)));
  layoutState.logHeight = clamped;

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LOG_HEIGHT_KEY, String(clamped));
  }
}

export function toggleMobileLog(): void {
  layoutState.mobileLogOpen = !layoutState.mobileLogOpen;
}

export function setLogPanelView(view: "logs" | "details"): void {
  layoutState.logPanelView = view;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LOG_VIEW_KEY, view);
  }
}

export function closeMobileLog(): void {
  layoutState.mobileLogOpen = false;
}
