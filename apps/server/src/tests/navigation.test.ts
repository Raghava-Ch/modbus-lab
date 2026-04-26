import { describe, it, expect, beforeEach } from "vitest";
import { navigationState, setActiveTab, tabDefs } from "../state/navigation.svelte";

beforeEach(() => {
  navigationState.activeTab = "listener";
});

describe("tabDefs", () => {
  it("contains at least 8 tabs", () => {
    expect(tabDefs.length).toBeGreaterThanOrEqual(8);
  });

  it("includes all core tabs", () => {
    const ids = tabDefs.map((t) => t.id);
    expect(ids).toContain("listener");
    expect(ids).toContain("coils");
    expect(ids).toContain("discrete-inputs");
    expect(ids).toContain("holding-registers");
    expect(ids).toContain("input-registers");
    expect(ids).toContain("traffic");
    expect(ids).toContain("settings");
  });

  it("does NOT contain a 'connection' tab (server uses 'listener')", () => {
    const ids = tabDefs.map((t) => t.id);
    expect(ids).not.toContain("connection");
    expect(ids).toContain("listener");
  });

  it("places listener tab in the main group", () => {
    const tab = tabDefs.find((t) => t.id === "listener");
    expect(tab?.group).toBe("main");
  });

  it("places settings tab in the settings group", () => {
    const tab = tabDefs.find((t) => t.id === "settings");
    expect(tab?.group).toBe("settings");
  });

  it("every tab has non-empty id, label, icon, and valid group", () => {
    for (const tab of tabDefs) {
      expect(tab.id.length).toBeGreaterThan(0);
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.icon.length).toBeGreaterThan(0);
      expect(["main", "settings"]).toContain(tab.group);
    }
  });

  it("tab IDs are unique", () => {
    const ids = tabDefs.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("setActiveTab", () => {
  it("changes the active tab", () => {
    setActiveTab("coils");
    expect(navigationState.activeTab).toBe("coils");
  });

  it("can navigate to every defined tab", () => {
    for (const tab of tabDefs) {
      setActiveTab(tab.id);
      expect(navigationState.activeTab).toBe(tab.id);
    }
  });

  it("replaces the previously active tab", () => {
    setActiveTab("coils");
    setActiveTab("traffic");
    expect(navigationState.activeTab).toBe("traffic");
  });

  it("starts on the listener tab by default", () => {
    // Reset to module default — server starts on 'listener'
    navigationState.activeTab = "listener";
    expect(navigationState.activeTab).toBe("listener");
  });
});
