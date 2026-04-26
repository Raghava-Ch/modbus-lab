export type LogLevel = "info" | "warn" | "error" | "traffic";
export type LogFilter = "all" | LogLevel;
export type LogExportScope = "all" | "filtered";
export type LogPanelView = "logs" | "details";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  message: string;
}
