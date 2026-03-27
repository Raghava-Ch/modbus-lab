export type LogLevel = "info" | "warn" | "error" | "traffic";
export type LogFilter = "all" | LogLevel;
export type LogExportScope = "all" | "filtered";

export interface LogEntry {
  id: number;
  timestamp: string;
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
  logState.entries = [
    ...logState.entries,
    {
      id: nextId++,
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
    },
  ];
}

export function clearLogs(): void {
  logState.entries = [];
}

export function setLogFilter(filter: LogFilter): void {
  logState.filter = filter;
}

function formatLogEntries(entries: LogEntry[]): string {
  return entries
    .map((entry) => `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}`)
    .join("\n");
}

function buildLogFileName(scope: LogExportScope, filter: LogFilter): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = scope === "all" ? "all-events" : filter === "all" ? "visible-events" : `${filter}-events`;
  return `modbux-${suffix}-${stamp}.log`;
}

export function saveLogsToFile(entries: LogEntry[], scope: LogExportScope, filter: LogFilter): void {
  if (typeof document === "undefined" || entries.length === 0) {
    return;
  }

  const blob = new Blob([formatLogEntries(entries)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = buildLogFileName(scope, filter);
  anchor.style.display = "none";

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
