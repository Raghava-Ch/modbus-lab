import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  notificationState,
  pushNotification,
  dismissNotification,
  clearNotifications,
  notifyInfo,
  notifyWarning,
  notifyError,
} from "../state/notifications.svelte";

beforeEach(() => {
  clearNotifications();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pushNotification", () => {
  it("adds one entry to state", () => {
    pushNotification("info", "hello");
    expect(notificationState.entries).toHaveLength(1);
  });

  it("stores message and level", () => {
    pushNotification("warn", "check connection");
    expect(notificationState.entries[0].message).toBe("check connection");
    expect(notificationState.entries[0].level).toBe("warn");
  });

  it("returns a numeric ID", () => {
    const id = pushNotification("info", "msg");
    expect(typeof id).toBe("number");
  });

  it("returns unique IDs for successive notifications", () => {
    const id1 = pushNotification("info", "first");
    const id2 = pushNotification("info", "second");
    expect(id2).toBeGreaterThan(id1);
  });

  it("auto-dismisses after TTL elapses", () => {
    pushNotification("info", "transient", 1000);
    expect(notificationState.entries).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(notificationState.entries).toHaveLength(0);
  });

  it("does NOT auto-dismiss before TTL elapses", () => {
    pushNotification("info", "still here", 1000);
    vi.advanceTimersByTime(999);
    expect(notificationState.entries).toHaveLength(1);
  });

  it("does not auto-dismiss when ttlMs is 0", () => {
    pushNotification("error", "permanent", 0);
    vi.advanceTimersByTime(60_000);
    expect(notificationState.entries).toHaveLength(1);
  });

  it("accumulates multiple notifications", () => {
    pushNotification("info", "a");
    pushNotification("warn", "b");
    pushNotification("error", "c");
    expect(notificationState.entries).toHaveLength(3);
  });
});

describe("dismissNotification", () => {
  it("removes the notification with the given ID", () => {
    const id = pushNotification("warn", "msg");
    dismissNotification(id);
    expect(notificationState.entries).toHaveLength(0);
  });

  it("leaves other notifications intact", () => {
    const id1 = pushNotification("info", "first");
    pushNotification("info", "second");
    dismissNotification(id1);
    expect(notificationState.entries).toHaveLength(1);
    expect(notificationState.entries[0].message).toBe("second");
  });

  it("does nothing for an unknown ID", () => {
    pushNotification("info", "present");
    dismissNotification(99999);
    expect(notificationState.entries).toHaveLength(1);
  });
});

describe("clearNotifications", () => {
  it("removes all notifications at once", () => {
    pushNotification("info", "a");
    pushNotification("warn", "b");
    clearNotifications();
    expect(notificationState.entries).toHaveLength(0);
  });

  it("is idempotent on an already empty list", () => {
    clearNotifications();
    expect(notificationState.entries).toHaveLength(0);
  });
});

describe("convenience helpers", () => {
  it("notifyInfo creates an info-level notification", () => {
    notifyInfo("info msg");
    expect(notificationState.entries[0].level).toBe("info");
  });

  it("notifyWarning creates a warn-level notification", () => {
    notifyWarning("warn msg");
    expect(notificationState.entries[0].level).toBe("warn");
  });

  it("notifyError creates an error-level notification", () => {
    notifyError("err msg");
    expect(notificationState.entries[0].level).toBe("error");
  });
});
