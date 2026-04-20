export type AppNotificationLevel = "info" | "warn" | "error";

export interface AppNotification {
  id: number;
  level: AppNotificationLevel;
  message: string;
}

const DEFAULT_TTL_MS = 4200;
let nextNotificationId = 1;

export const notificationState = $state({
  entries: [] as AppNotification[],
});

export function pushNotification(
  level: AppNotificationLevel,
  message: string,
  ttlMs: number = DEFAULT_TTL_MS,
): number {
  const id = nextNotificationId++;
  notificationState.entries = [...notificationState.entries, { id, level, message }];

  if (ttlMs > 0) {
    setTimeout(() => {
      dismissNotification(id);
    }, ttlMs);
  }

  return id;
}

export function dismissNotification(id: number): void {
  notificationState.entries = notificationState.entries.filter((entry) => entry.id !== id);
}

export function clearNotifications(): void {
  notificationState.entries = [];
}

export function notifyInfo(message: string, ttlMs?: number): number {
  return pushNotification("info", message, ttlMs);
}

export function notifyWarning(message: string, ttlMs?: number): number {
  return pushNotification("warn", message, ttlMs);
}

export function notifyError(message: string, ttlMs?: number): number {
  return pushNotification("error", message, ttlMs);
}
