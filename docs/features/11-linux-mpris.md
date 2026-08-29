# 11 — Linux D-Bus MPRIS Media Control

**Branch:** prem22k
**Status:** Implemented (Linux only)
**Date:** 2026-08-29

---

## Problem

Media control on Linux previously required spawning sub-shells (`pkill`,
`dbus-send`), which was slow and unreliable. The user wanted native,
zero-latency media playback control.

## Implementation (`src-tauri/src/mpris.rs`)

Uses `zbus` 5.x for direct D-Bus session bus communication.

### `send_mpris_command()`

```rust
#[cfg(target_os = "linux")]
pub async fn send_mpris_command(command: &str) -> Result<String, String> {
    use zbus::fdo::DBusProxy;
    use zbus::Connection;

    let connection = Connection::session().await
        .map_err(|e| format!("Failed to connect to D-Bus session: {e}"))?;

    let dbus_proxy = DBusProxy::new(&connection).await?;
    let names = dbus_proxy.list_names().await?;

    // Find all MPRIS-registered media players
    let mpris_players: Vec<String> = names
        .into_iter()
        .filter(|n| n.as_str().starts_with("org.mpris.MediaPlayer2."))
        .map(|n| n.to_string())
        .collect();

    let method = match command {
        "play_pause" | "toggle" => "PlayPause",
        "play" => "Play",
        "pause" => "Pause",
        "next" => "Next",
        "previous" | "prev" => "Previous",
        "stop" => "Stop",
        _ => return Err(format!("Unknown MPRIS command: {command}")),
    };

    // Send command to all active media players
    for player in &mpris_players {
        connection.call_method(
            Some(player.as_str()),
            "/org/mpris/MediaPlayer2",
            Some("org.mpris.MediaPlayer2.Player"),
            method,
            &(),
        ).await?;
    }
    Ok(format!("Sent {command} to {sent} media player(s)"))
}
```

### `send_native_notification()`

Desktop toast notifications via D-Bus `org.freedesktop.Notifications`.

### Platform gating

Only compiled on Linux:
```rust
#[cfg(target_os = "linux")]
pub async fn send_mpris_command(...) { ... }

#[cfg(not(target_os = "linux"))]
pub async fn send_mpris_command(command: &str) -> Result<String, String> {
    Err(format!("MPRIS not available on this platform"))
}
```

## Supported Commands

| Command | MPRIS Method |
|---|---|
| play_pause / toggle | PlayPause |
| play | Play |
| pause | Pause |
| next | Next |
| previous / prev | Previous |
| stop | Stop |

## Files Changed

- `src-tauri/src/mpris.rs` — New file (109 lines)
- `src-tauri/src/lib.rs` — Module registration
- `src-tauri/src/command_executor.rs` — MPRIS command execution
- `src-tauri/Cargo.toml` — zbus dependency
