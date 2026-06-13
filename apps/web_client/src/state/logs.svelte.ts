export type LogLevel = "info" | "warn" | "error" | "traffic";
export type LogFilter = "all" | LogLevel;
export type LogExportScope = "all" | "filtered";

import { settingsState, formatLogTimestamp } from "./settings.svelte";

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
  logState.entries.push({ id: nextId++, timestamp: Date.now(), level, message });
  const max = Math.max(200, settingsState.logs.maxRetainedEntries);
  if (logState.entries.length > max) {
    logState.entries.splice(0, logState.entries.length - max);
  }

  // Map only important logs to browser console to prevent performance overhead
  if (level !== "traffic") {
    const logPrefix = `[ModbusLab][${level.toUpperCase()}]`;
    if (level === "error") {
      console.error(logPrefix, message);
    } else if (level === "warn") {
      console.warn(logPrefix, message);
    } else {
      console.log(logPrefix, message);
    }
  }
}

export function clearLogs(): void {
  logState.entries = [];
}

export function setLogFilter(filter: LogFilter): void {
  logState.filter = filter;
}

function formatLogEntries(entries: LogEntry[], scope: LogExportScope, filter: LogFilter): string {
  const header = [
    "# Modbus-Lab Log Export",
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
  return `Modbus-Lab-${suffix}-${stamp}.log`;
}

export async function saveLogsToFile(entries: LogEntry[], scope: LogExportScope, filter: LogFilter): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const content = formatLogEntries(entries, scope, filter);
  const defaultName = buildLogFileName(scope, filter);

  try {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
    console.log("Log file export triggered successfully as download:", defaultName);
  } catch (error) {
    console.error("Failed to export log file:", error);
  }
}
