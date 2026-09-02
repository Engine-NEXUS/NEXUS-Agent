/**
 * Loading indicator controller — shows/hides the transparent click-through
 * loading animation window.
 *
 * The loading indicator is a separate Tauri window (label: "loading-indicator")
 * that appears at the top-right corner of the screen. It shows the loading.json
 * Lottie animation while NEXUS is processing a request.
 *
 * Show: called when "On it sir" is spoken and the orb (wakeup animation) hides.
 * Hide: called when the Worker response arrives (or on error/cancel).
 */

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Show the loading indicator window. Idempotent — safe to call multiple times. */
export async function showLoadingIndicator(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_loading_indicator");
  } catch (e) {
    console.warn("[NEXUS] show_loading_indicator failed:", e);
  }
}

/** Hide/destroy the loading indicator window. Idempotent — safe to call when not shown. */
export async function hideLoadingIndicator(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hide_loading_indicator");
  } catch (e) {
    console.warn("[NEXUS] hide_loading_indicator failed:", e);
  }
}
