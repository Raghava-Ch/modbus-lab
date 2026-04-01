export type LogLevel = "info" | "warn" | "error" | "traffic";
export type LogFilter = "all" | LogLevel;
export type LogExportScope = "all" | "filtered";

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { enforceLogRetention, formatLogTimestamp } from "./settings.svelte";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  message: string;
}

let nextId = 1;

export const logState = $state({
  entries: [] as LogEntry[],
  filter: "all" as LogFilter,
});

export function getFilteredLogs(filter: LogFilter): LogEntry[] {
  return filter === "all"
    ? logState.entries
    : logState.entries.filter((entry) => entry.level === filter);
}

export function addLog(level: LogLevel, message: string): void {
  const nextEntries = [
    ...logState.entries,
    {
      id: nextId++,
      timestamp: Date.now(),
      level,
      message,
    },
  ];
  logState.entries = enforceLogRetention(nextEntries);
}

export function clearLogs(): void {
  logState.entries = [];
}

export function setLogFilter(filter: LogFilter): void {
  logState.filter = filter;
}

function formatLogEntries(entries: LogEntry[], scope: LogExportScope, filter: LogFilter): string {
  const header = [
    "# ModBux Log Export",
    `# exportedAt=${new Date().toISOString()}`,
    `# scope=${scope}`,
    `# filter=${filter}`,
    `# count=${entries.length}`,
    "",
  ].join("\n");

  const lines = entries
    .map((entry) => `[${formatLogTimestamp(entry.timestamp)}] ${entry.level.toUpperCase()} ${entry.message}`)
    .join("\n");

  return `${header}${lines}`;
}

function buildLogFileName(scope: LogExportScope, filter: LogFilter): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = scope === "all" ? "all-events" : filter === "all" ? "visible-events" : `${filter}-events`;
  return `modbux-${suffix}-${stamp}.log`;
}

export async function saveLogsToFile(entries: LogEntry[], scope: LogExportScope, filter: LogFilter): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const content = formatLogEntries(entries, scope, filter);
  const defaultName = buildLogFileName(scope, filter);

  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [
        { name: "Log Files", extensions: ["log"] },
        { name: "Text Files", extensions: ["txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (filePath) {
      await writeTextFile(filePath, content);
      console.log("Log file saved successfully to:", filePath);
    } else {
      console.log("Log file save cancelled by user");
    }
  } catch (error) {
    console.error("Failed to save log file:", error);
  }
}
