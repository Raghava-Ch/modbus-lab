import { describe, it, expect, beforeEach } from "vitest";
import { navigationState, setActiveTab, tabDefs } from "../state/navigation.svelte";

beforeEach(() => {
  navigationState.activeTab = "connection";
});

describe("tabDefs", () => {
  it("contains at least 8 tabs", () => {
    expect(tabDefs.length).toBeGreaterThanOrEqual(8);
  });

  it("includes all core tabs", () => {
    const ids = tabDefs.map((t) => t.id);
    expect(ids).toContain("connection");
    expect(ids).toContain("coils");
    expect(ids).toContain("discrete-inputs");
    expect(ids).toContain("holding-registers");
    expect(ids).toContain("input-registers");
    expect(ids).toContain("diagnostics");
    expect(ids).toContain("settings");
  });

  it("places connection tab in the settings group", () => {
    const conn = tabDefs.find((t) => t.id === "connection");
    expect(conn?.group).toBe("settings");
  });

  it("places coils tab in the main group", () => {
    const coils = tabDefs.find((t) => t.id === "coils");
    expect(coils?.group).toBe("main");
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
    setActiveTab("diagnostics");
    expect(navigationState.activeTab).toBe("diagnostics");
  });
});
