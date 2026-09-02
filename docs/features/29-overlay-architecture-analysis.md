# Overlay Architecture Analysis: Is Tauri Multi-Window the Best Approach?

*Date: 2026-09-02*

An architectural review of NEXUS’s overlay UI approach (multiple transparent Tauri WebViews) against industry standards for cross-platform desktop assistants.

---

## 1. The Current Approach: Multi-Window Tauri (WebViews)

NEXUS currently spawns multiple transparent, floating `WebView2`/`WebKit` windows on demand (Orb, Sidebar, Architect, Loading Indicator).

### The Good
*   **Rapid UI Development:** Using React, Tailwind, and Framer Motion allows for incredibly fluid, beautiful UI that is difficult and slow to build in native C++/Rust/Swift.
*   **Lazy Loading:** By dynamically creating/destroying windows (`dyn_windows.rs`), you keep idle RAM relatively low (only the Orb is alive at boot).

### The Bad
*   **Process Bloat:** Every time a window opens, the OS spawns a new browser process tree (Renderer, GPU, Network). Opening the Sidebar and Architect together can spike RAM by **300–500 MB**.
*   **Creation Latency:** `WebviewWindowBuilder` takes 200–500ms to initialize a new window. For a voice assistant, this feels sluggish compared to an instant native UI.
*   **Wayland Hostility:** As discovered, Linux Wayland breaks un-decorated floating WebViews, ignoring absolute positioning and blocking click-through APIs entirely.

---

## 2. Alternative A: Single Full-Screen Transparent Overlay
Instead of 4 windows, create **one** invisible window that covers the entire screen. The Orb, Sidebar, and Loading Indicator are just React `<divs>` that fade in and out.

### Pros
*   **Massive RAM Savings:** Only one WebView process runs.
*   **Zero Latency:** Showing the sidebar is just a React state change (`setShowSidebar(true)`). It appears instantly with 0ms OS overhead.
*   **Shared State:** No need for complex Rust IPC to pass data between the Architect and Sidebar windows.

### Cons (The "Click-Through" Nightmare)
*   A full-screen transparent window absorbs **all** mouse clicks. You cannot click the desktop behind it.
*   To fix this, you must dynamically toggle `set_ignore_cursor_events(true/false)` depending on whether the mouse is over the Orb/Sidebar or empty space.
*   *Fatal Flaw:* Mouse-tracking lag can cause you to accidentally click the desktop when aiming for the sidebar. Furthermore, **this still fails completely on Linux Wayland**.

---

## 3. Alternative B: Native Rust UI (Slint / Iced)
Rip out Tauri/React completely and build the UI using a compiled Rust GUI framework like **Slint** or **Iced**.

### Pros
*   **The Ultimate Performance:** RAM usage would drop from ~350 MB to **~30 MB**. CPU usage would plummet.
*   **Instantaneous:** Windows appear in 1ms. 
*   **True OS Integration:** Direct access to native Wayland `layer-shell` (Linux) and `DesktopAcrylicController` (Windows) without WebKit getting in the way.

### Cons
*   **The Rewrite:** Massive engineering effort. 
*   **Loss of Web Ecosystem:** No React, no Tailwind, no Lottie animations, no Framer Motion. Rendering complex Markdown and Mermaid.js graphs (used in Architect) is notoriously difficult in native Rust UI frameworks compared to a browser engine.

---

## 4. Alternative C: The Industry Standard (The Hybrid "Raycast" Model)
Apps like Raycast (macOS) or PowerToys (Windows) use a hybrid approach to achieve perfect performance and OS integration.

### How it works
*   **The Persistent Widgets (Orb & Loading):** Built in pure native code (Swift on Mac, C++/WinUI on Windows, GTK/Layer-Shell on Linux). They consume ~5 MB of RAM, are perfectly click-through, and never lag.
*   **The Heavy Content (Sidebar & Architect):** Built using WebViews (Tauri/Electron). They only spawn when complex data (Markdown/Graphs) needs to be shown, and die when hidden.

## 5. Future Evolution: Customizable, Resizable, and Dockable Layouts

If the future vision for NEXUS involves breaking away from rigid, fixed-size windows to allow users to customize, resize, snap, and dock panels to their own taste (similar to an IDE like VS Code or OBS Studio), the architecture must shift. 

### The Problem with OS-Level Multi-Window Docking
Currently, NEXUS relies on OS-level windows (`tauri::WindowBuilder`) for the Sidebar and Architect. While you can easily set `resizable: true` on a Tauri window, implementing magnetic docking, tab-stacking, or complex grid layouts *across separate OS processes* is notoriously janky. Coordinating window positions via Rust IPC introduces visual lag, and managing the Z-index of 5 different floating webviews is fragile. Furthermore, spinning up 5 WebViews for 5 separate user panels would consume a massive amount of RAM (700MB+).

### The "Dashboard" Architecture Solution
To achieve a fluid, customizable workspace that "feels right," the industry standard approach (used by Discord, VS Code, and Slack) is to utilize a **Single Webview Dashboard** coupled with a React docking library.

*   **How it works:** Instead of floating UI overlays that hover over other apps, you spawn a single, standard desktop application window (with `decorations: false` so you can build a custom draggable titlebar). Inside this single React app, you implement a pane-management library.
*   **The Recommended Library (Dockview):** Our research shows that **Dockview** is the current state-of-the-art for building VS Code-style docking architectures in React. It supports tab groups, splitters, floating panels, and saving/restoring user layout preferences natively. (Note: *Golden Layout* is now considered legacy and highly prone to React state bugs, while *FlexLayout* is a viable but older alternative).
*   **Performance:** Because the entire customized workspace runs inside a single WebView, the RAM overhead remains flat (~200MB) regardless of how many panels or tabs the user arranges.
*   **The Paradigm Shift:** This means splitting the app's identity. The **Orb** remains a tiny, persistent, floating OS overlay that listens to voice commands. However, when the user wants to see complex data (Architect graphs, search results, code), the Orb opens the **Dashboard** window—a customizable, resizable workspace where the user dictates the layout.

---

## Conclusion: Are you on the right track?

For a solo developer or small team building a **cross-platform** app with fixed layouts, **your current multi-window Tauri approach is the most pragmatic choice.** 

However, if the product roadmap requires a highly customizable, dockable workspace, you will hit a wall trying to orchestrate that via OS-level Tauri windows.

### Recommended Action Plan:
1.  **Near-term:** Fix the current fixed-window architecture. Do not use a separate 80x80 window for the loading Lottie. Render it *inside* the existing Orb window's React tree to avoid the Wayland click-blocking bug and save 150 MB of RAM.
2.  **Long-term (Customizable UI):** Transition the heavy content (Sidebar/Architect) into a single resizable **Dashboard Window** powered by `dockview` in React. Keep the Orb as the only floating OS overlay.
