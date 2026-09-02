# Linux & Wayland Compatibility Research

*Date: 2026-09-02*

This document outlines the current architectural pain points when running NEXUS on Linux (specifically Wayland-based distributions like Pop!_OS and Ubuntu), along with open-source solutions to address them.

## 1. Window Management & "Click-Through" on Wayland

### The Problem
NEXUS uses two floating, click-through overlays: the main orb/loading indicator and the response/architect sidebars. 
- **Absolute Positioning:** Wayland compositors (like Mutter in GNOME) often strip absolute coordinate positioning (`set_position()`) from standard un-decorated windows for security, causing them to spawn randomly on the screen.
- **Click-Through (`set_ignore_cursor_events`):** This API is entirely ignored on Wayland due to WebKitGTK limitations. Instead of passing clicks through to the desktop, the new 80x80 `loading-indicator` window acts as a solid, invisible box that intercepts and blocks all mouse clicks underneath it.
- **Background Blur:** The Win32 GDI `capture_backdrop` technique is disabled on Linux.

### The Solutions
*   **Layer Shell Protocol:** True floating, click-through overlays on Wayland require the `wlr-layer-shell` or `gtk-layer-shell` protocols. Since Tauri v2/Wry does not natively support this yet, you must use a Rust crate like **`gtk-layer-shell`** to manually spawn the orb/indicator outside of Tauri's standard window builder.
*   **Immediate Workaround:** Do not spawn a separate 80x80 window for the loading indicator on Linux. Render the Lottie animation directly inside the existing main orb window to prevent creating a second invisible click-blocking "dead zone".
*   **Blur Workaround:** Set `"transparent": true` in `tauri.conf.json` and use CSS `backdrop-filter: blur(20px)`. While it won't blur natively on all DEs, it degrades gracefully to a sleek, semi-transparent dark panel, or works if the user forces KWin blur rules (KDE) or GNOME extensions.

## 2. Audio Stack Fragmentation (PipeWire vs. ALSA)

### The Problem
NEXUS uses `cpal` to capture audio and blindly requests the ALSA `default` device (`host.default_input_device()`). On modern Linux using PipeWire, the `pipewire-alsa` compatibility layer often routes this default request to a virtual monitor sink (which records system audio) or an inactive microphone line. The openWakeWord engine receives near-zero RMS audio (electrical static), resulting in the engine being completely deaf to the user's voice.

### The Solutions
*   **Code Solution:** Modern Linux audio applications bypass ALSA and use native PipeWire bindings. Replace `cpal` with the **`pipewire`** Rust crate for Linux targets. This allows explicit querying of nodes to connect directly to the active `Audio/Source` (the user's headset).
*   **Zero-Code Workaround (For Users):** Instruct users to install/open `pavucontrol` (PulseAudio Volume Control), go to the **Input Devices** tab, and click the **"Set as fallback"** button next to their actual working microphone. This forces PipeWire to route that specific mic to the ALSA `default` alias that NEXUS requests.

## 3. Global Hotkeys

### The Problem
The `Ctrl+Space` wake button and the `Ctrl+Alt+A` debug button use `tauri-plugin-global-shortcut`, which relies on X11's `XGrabKey`. Wayland security strictly blocks global keyboard snooping, meaning these hotkeys will fail to register or silently do nothing on pure Wayland.

### The Solutions
*   **The XDG Portal Way:** Modern Linux apps use the `org.freedesktop.portal.GlobalShortcuts` D-Bus portal. Implement the **`ashpd`** Rust crate (`ashpd::desktop::global_shortcuts`). This securely asks the Wayland compositor to register the shortcut and sends a D-Bus signal back to NEXUS when pressed.
*   **CLI Workaround:** Remove the global shortcut plugin on Linux. Instruct users to bind a custom keyboard shortcut in their Desktop Environment settings that executes `nexus --wake`. Use the **`tauri-plugin-single-instance`** crate to catch that CLI execution and emit a wake event to the background instance.

## 4. App Discovery & Flatpak Sandboxing

### The Problem
The current `close_app` intent uses `pkill -f [app_name]`. If an app is installed via Flatpak or Snap, its actual process name is buried under a sandbox wrapper (like `bwrap`), causing the kill command to fail. Additionally, scanning the Windows Registry (`app_registry.rs`) doesn't work for finding Linux apps.

### The Solutions
*   **Linux App Discovery:** Use the **`freedesktop-desktop-entry`** or **`freedesktop-file-parser`** crates to instantly parse `.desktop` files in `/usr/share/applications/`, `~/.local/share/applications/`, and `/var/lib/flatpak/exports/share/applications/`.
*   **Executing Apps:** The `Exec=` line inside the `.desktop` file provides the exact command needed to launch the app (e.g., `flatpak run org.mozilla.firefox`), abstracting away whether it's a native binary or a sandboxed container.

## 5. Python Sidecar Packaging (glibc)

### The Problem
If the GitHub Actions CI builds the `faster-whisper` and NLU Python sidecars on `ubuntu-latest` (Ubuntu 24.04), they link against a new version of `glibc`. Users on older distros (like Debian 12 or Ubuntu 22.04) will experience crashes with `glibc version not found`.

### The Solutions
*   **Manylinux Containers:** In `.github/workflows/ci.yml`, run the Python build step inside a `manylinux2014` Docker container (based on CentOS 7). This links the binary against an older `glibc` (v2.17), ensuring universal compatibility across 99% of modern Linux distributions.
*   **Staticx Wrapper:** Alternatively, run **`staticx`** on the Python binaries after PyInstaller builds them to bundle the `glibc` library directly into a truly static executable.
