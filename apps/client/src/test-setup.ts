import { vi } from "vitest";

// Mock all Tauri API modules — they rely on native IPC which isn't available in jsdom.
// Individual tests override `invoke` return values with vi.mocked(invoke).mockResolvedValueOnce(...)

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
}));
