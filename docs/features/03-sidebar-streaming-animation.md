# 03 — Sidebar Streaming Text Animation

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

The user wanted text to appear in the sidebar like ChatGPT/Gemini:
- Words fade in sequentially from top to bottom
- Left-to-right flow within each line
- Natural word spacing (no uneven gaps)
- Line breaks preserved
- Auto-scroll while text appears

## Implementation

### Rust (`src-tauri/src/commands.rs` — `show_sidebar_with_content()`)

The Rust side directly evaluates JavaScript in the sidebar WebView to build
the animated text:

1. Split response by line (`\n`)
2. Each line split by whitespace
3. Empty words skipped
4. Each word becomes a `.word` span with:
   - The trailing space INSIDE the span (except the last word in each line)
   - `display: inline` (NOT `inline-block` — that caused spacing issues)
5. `<br>` elements preserve newlines
6. Animation delays staggered ~28ms per word, capped at 2000ms
7. Timer scrolls the response container every 50ms
8. Scrolling stops after the animation window

### CSS (`frontend/src/sidebar/sidebar.css`)

```css
.word {
  opacity: 0;
  animation: wordFadeIn 0.4s ease forwards;
}

@keyframes wordFadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Words fade from transparent and slightly translated downward into their
final position. The staggered delays create the top-to-bottom, left-to-right
flow effect.

## Bug Fixed: Uneven Spacing

### Initial implementation (broken)
- Used `display: inline-block` on word spans
- Appended separate text-node spaces between spans
- Result: Gaps were inconsistent, text didn't flow naturally left-to-right

### Fix (working)
- Removed `display: inline-block` — kept words inline
- Put the trailing space INSIDE each word span (except the last word in a line)
- Filtered empty words
- Preserved line breaks with `<br>` elements

### User confirmation
> "Perfect spacing"

## Files Changed

- `src-tauri/src/commands.rs` — Word span creation, animation delays, auto-scroll
- `frontend/src/sidebar/sidebar.css` — Word fade-in keyframes
