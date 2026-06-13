/**
 * Tracks the app initialization state to prevent flickering on startup.
 * The app won't render its main UI until all initialization is complete.
 */

class InitializationManager {
  isInitialized = $state(false);

  markComplete(): void {
    console.log("[init] Marking initialization as complete");
    this.isInitialized = true;
  }
}

export const initManager = new InitializationManager();
