/**
 * Tracks the app initialization state to prevent flickering on startup.
 * The app won't render its main UI until all initialization is complete.
 */

export const initializationState = $state({
  isInitialized: false,
  isInitializing: true,
});

export function markInitializationComplete(): void {
  initializationState.isInitialized = true;
  initializationState.isInitializing = false;
}
