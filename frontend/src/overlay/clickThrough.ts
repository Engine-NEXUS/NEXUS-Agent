import { invoke } from "@tauri-apps/api/core";

/**
 * Region-aware click-through (Strategy A from ARCHITECTURE.md §5.1).
 *
 * We attach a single `pointermove` listener. On each move we test whether the pointer is
 * over an opaque (avatar) element using `document.elementFromPoint`. We only call the Rust
 * `set_click_through` IPC when the *desired* state flips, so we avoid per-move IPC thrash.
 *
 * When over the avatar -> ignore=false (interactive).
 * When over transparent root -> ignore=true (clicks fall through to the OS app below).
 */
export function attachClickThrough(): () => void {
  let currentIgnore = true; // window starts click-through (set by Rust init)
  let raf = 0;

  const onMove = (e: PointerEvent) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      // The root #app is the transparent layer; anything with data-interactive is the avatar.
      const overAvatar =
        !!el && el.closest("[data-interactive]") != null;
      const wantIgnore = !overAvatar;
      if (wantIgnore !== currentIgnore) {
        currentIgnore = wantIgnore;
        invoke("set_click_through", { ignore: wantIgnore }).catch(() => {});
      }
    });
  };

  window.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    window.removeEventListener("pointermove", onMove);
    cancelAnimationFrame(raf);
  };
}
