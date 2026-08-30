# NEXUS Unified Launcher
# Runs STT server + NEXUS desktop app in ONE terminal with color-coded logs.
# All output (STT transcription, Rust wake-word, frontend console, commands)
# appears in a single scrolling view.
#
# Usage:
#   pwsh ./scripts/run.ps1              # normal start
#   pwsh ./scripts/run.ps1 -Build       # rebuild before starting
#   pwsh ./scripts/run.ps1 -Debug       # enable CDP debugging port 9222
#
# Press Ctrl+C to stop everything cleanly.

param(
  [switch]$Build,
  [switch]$Debug
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = "$env:APPDATA\com.nexus.assistant"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# ─── Colors ────────────────────────────────────────────────────────────────
$C_STT   = "Cyan"      # STT server logs
$C_RUST  = "Green"     # Rust wake-word / audio logs
$C_FRONT = "Yellow"    # Frontend console logs (via CDP)
$C_CMD   = "Magenta"   # Command execution
$C_SYS   = "DarkGray"  # System / launcher messages
$C_ERR   = "Red"       # Errors

function Write-Log([string]$Tag, [string]$Msg, [string]$Color = "White") {
  $ts = Get-Date -Format "HH:mm:ss"
  Write-Host "[$ts] " -NoNewline -ForegroundColor $C_SYS
  Write-Host "$Tag " -NoNewline -ForegroundColor $Color
  Write-Host $Msg
}

# ─── Cleanup helper ────────────────────────────────────────────────────────
$jobs = [System.Collections.ArrayList]::new()
$cts = [System.Threading.CancellationTokenSource]::new()

function Stop-All {
  Write-Log "STOP" "Shutting down all processes..." $C_ERR
  foreach ($j in $jobs) {
    try {
      if ($j.Process -and -not $j.Process.HasExited) {
        $j.Process.Kill()
      }
    } catch {}
  }
  Get-Process nexus -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*stt_server*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*cdp_monitor*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Log "STOP" "All processes stopped." $C_ERR
}

trap {
  Write-Log "ERR" "Unhandled error: $_" $C_ERR
  Stop-All
  exit 1
}

# ─── Build if requested ────────────────────────────────────────────────────
if ($Build) {
  Write-Log "BUILD" "Building frontend..." $C_SYS
  npm --prefix frontend run build 2>&1 | Out-Host
  Write-Log "BUILD" "Building Rust (release + custom-protocol)..." $C_SYS
  Push-Location src-tauri
  cargo build --release --features custom-protocol 2>&1 | Out-Host
  Pop-Location
  if ($LASTEXITCODE -ne 0) {
    Write-Log "BUILD" "Build FAILED" $C_ERR
    exit 1
  }
  Write-Log "BUILD" "Build complete." $C_SYS
}

# ─── Kill any existing instances ───────────────────────────────────────────
Write-Log "INIT" "Killing existing NEXUS / STT instances..." $C_SYS
Get-Process nexus -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Also kill orphaned WebView2 child processes left by previous NEXUS runs
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*stt_server*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3

# Use timestamped log filenames so we never conflict with a lingering
# file handle from a previous run.ps1 that was killed without cleanup.
# The old approach (Clear-Content on a fixed filename) failed when a
# zombie process held an exclusive write lock on the log file — Windows
# doesn't release handles instantly after Stop-Process. Unique filenames
# sidestep the issue entirely.
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$sttLog = "$LogDir\stt_unified.log"
$sttErr = "$LogDir\stt_unified_err.log"
$nexusLog = "$LogDir\nexus_${stamp}.log"
$nexusErr = "$LogDir\nexus_${stamp}_err.log"
$cdpLog = "$LogDir\cdp_unified.log"
$cdpErr = "$LogDir\cdp_unified_err.log"

# Clean up old timestamped log files (keep only the 5 most recent)
Get-ChildItem "$LogDir\nexus_*.log" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 5 |
  Remove-Item -Force -ErrorAction SilentlyContinue

# ─── STT Server ────────────────────────────────────────────────────────────
# NOTE: STT server is now started LAZILY by the Rust app (lazy_stt.rs) when
# the wake word fires, and killed after 60s of idle. This saves ~340 MB RAM
# at idle. The script path is auto-detected by lazy_stt.rs.
# If an external STT server is already running on port 39217, the Rust app
# will detect it and skip spawning its own.
Write-Log "INIT" "STT server will be started on-demand by NEXUS (lazy STT)" $C_STT

# ─── Start NEXUS ───────────────────────────────────────────────────────────
Write-Log "INIT" "Starting NEXUS desktop app..." $C_RUST

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = if ($Debug) { "--remote-debugging-port=9222" } else { "" }

$nexusProc = Start-Process -FilePath "$ProjectRoot\src-tauri\target\release\nexus.exe" `
  -RedirectStandardOutput $nexusLog `
  -RedirectStandardError $nexusErr `
  -PassThru -WindowStyle Hidden

$jobs.Add([PSCustomObject]@{ Name="NEXUS"; Process=$nexusProc }) | Out-Null

# Wait for NEXUS to start
Start-Sleep 5
if ($nexusProc.HasExited) {
  Write-Log "NEXUS" "CRASHED on startup — check $nexusErr" $C_ERR
  Get-Content $nexusErr | ForEach-Object { Write-Log "NEXUS" $_ $C_ERR }
  Stop-All
  exit 1
}
Write-Log "NEXUS" "App running (PID=$($nexusProc.Id))" $C_RUST

# ─── Start CDP monitor (frontend console logs) ────────────────────────────
$cdpScript = "$ProjectRoot\scripts\cdp_monitor.js"
if ($Debug -and (Test-Path $cdpScript)) {
  Write-Log "INIT" "Starting CDP console monitor..." $C_FRONT
  $cdpProc = Start-Process -FilePath "node" `
    -ArgumentList $cdpScript `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput "$LogDir\cdp_unified.log" `
    -RedirectStandardError "$LogDir\cdp_unified_err.log" `
    -PassThru -WindowStyle Hidden
  $jobs.Add([PSCustomObject]@{ Name="CDP"; Process=$cdpProc }) | Out-Null
}

# ─── Tail all logs in one stream ───────────────────────────────────────────
Write-Log "READY" "═══════════════════════════════════════════════════════" $C_SYS
Write-Log "READY" "  NEXUS Unified Console — all logs below" $C_SYS
Write-Log "READY" "  STT=Cyan  Rust=Green  Frontend=Yellow  Cmd=Magenta" $C_SYS
Write-Log "READY" "  Press Ctrl+C to stop everything" $C_SYS
Write-Log "READY" "═══════════════════════════════════════════════════════" $C_SYS
Write-Host ""

# Track file positions for incremental tailing
$pos = @{
  STT   = 0
  Rust  = 0
  CDP   = 0
  Err   = 0
}

function Get-NewLines([string]$File, [ref]$Position) {
  if (-not (Test-Path $File)) { return @() }
  $fi = Get-Item $File
  if ($fi.Length -lt $Position.Value) {
    # File was truncated/rotated — start from beginning
    $Position.Value = 0
  }
  if ($fi.Length -eq $Position.Value) { return @() }
  $lines = @()
  try {
    $fs = [System.IO.File]::Open($File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $fs.Seek($Position.Value, [System.IO.SeekOrigin]::Begin) | Out-Null
    # Read raw bytes instead of using StreamReader — StreamReader buffers
    # ahead, so $fs.Position ends up PAST the actual data, causing the
    # position tracker to reset to 0 on the next call and re-read everything
    $len = [int]($fs.Length - $Position.Value)
    $buf = New-Object byte[] $len
    $read = $fs.Read($buf, 0, $len)
    $Position.Value = $Position.Value + $read
    $fs.Close()
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
    $lines = $text -split "`r?`n" | Where-Object { $_ -ne "" }
  } catch {}
  return $lines
}

# Main tail loop
try {
  while (-not $nexusProc.HasExited) {
    Start-Sleep -Milliseconds 500

    # STT logs
    $sttLines = Get-NewLines $sttLog ([ref]$pos.STT)
    foreach ($line in $sttLines) {
      if ($line -match "transcribed (\d+) bytes.*?(\d+) chars in ([\d.]+)s") {
        Write-Log "STT" "transcribed: $($Matches[2]) chars in $($Matches[3])s" $C_STT
      } elseif ($line -match "INFO") {
        $clean = $line -replace '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} INFO ', ""
        if ($clean) { Write-Log "STT" $clean $C_STT }
      } elseif ($line -match "ERROR|WARN") {
        $clean = $line -replace '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} ', ""
        Write-Log "STT" $clean $C_ERR
      }
    }

    # Rust logs (wake word, audio, baton pass) — limit to 50 lines per cycle
    $rustLines = Get-NewLines $nexusLog ([ref]$pos.Rust)
    $rustShown = 0
    foreach ($line in $rustLines) {
      if ($rustShown -ge 50) { break }
      # Strip ANSI color codes
      $clean = $line -replace '\x1b\[[0-9;]*m', ""
      # Extract timestamp and level
      if ($clean -match "(\d{2}:\d{2}:\d{2}\.\d+).*?(INFO|DEBUG|WARN|ERROR|TRACE)\s+(.+)") {
        $level = $Matches[2]
        $msg = $Matches[3]
        # Skip TRACE entirely (AGC gain etc — too noisy)
        if ($level -eq "TRACE") { continue }
        $color = switch ($level) {
          "INFO"  { $C_RUST }
          "DEBUG" { "DarkGreen" }
          "WARN"  { "Yellow" }
          "ERROR" { $C_ERR }
          default { "White" }
        }
        # Highlight key events
        if ($msg -match "NEXUS detected|wake.*trigger") {
          Write-Log "WAKE" $msg $C_CMD; $rustShown++
        } elseif ($msg -match "stream paused|stream resumed|baton") {
          Write-Log "BATON" $msg $C_CMD; $rustShown++
        } elseif ($msg -match "model probability") {
          # Only show probabilities above 0.3
          if ($msg -match "probability=0\.[3-9]|probability=1\.") {
            Write-Log "WAKE" $msg "DarkYellow"; $rustShown++
          }
        } elseif ($msg -match "stream started|device|sample_rate|audio capture started") {
          Write-Log "AUDIO" $msg $C_RUST; $rustShown++
        } elseif ($msg -match "callbacks.*processed") {
          # Only show every 5000 callbacks (not every 1000)
          if ($msg -match "(\d+) callbacks" -and [int64]$Matches[1] % 5000 -eq 0) {
            Write-Log "AUDIO" $msg "DarkGray"; $rustShown++
          }
        } elseif ($level -eq "INFO") {
          Write-Log "RUST" $msg $color; $rustShown++
        } elseif ($level -eq "WARN" -or $level -eq "ERROR") {
          Write-Log "RUST" $msg $color; $rustShown++
        }
        # Skip all other DEBUG lines (audio passed gate, AGC, etc)
      }
    }

    # Frontend CDP logs
    if ($Debug -and (Test-Path "$LogDir\cdp_unified.log")) {
      $cdpLines = Get-NewLines "$LogDir\cdp_unified.log" ([ref]$pos.CDP)
      foreach ($line in $cdpLines) {
        $clean = $line -replace '\x1b\[[0-9;]*m', ""
        if ($clean -match "\[log\]\s*(.+)") {
          $msg = $Matches[1]
          if ($msg -match "baton pass|pause_wakeword|resume_wakeword") {
            Write-Log "BATON" $msg $C_CMD
          } elseif ($msg -match "VAD.*speech|VAD.*silence|VAD.*misfire") {
            # Only show speech start/end, not every frame
            if ($msg -match "speech start|speech end|speech real|misfire") {
              Write-Log "VAD" $msg $C_FRONT
            }
          } elseif ($msg -match "STT correction|transcript=|intent=|isLongRunning") {
            Write-Log "STT" $msg $C_FRONT
          } elseif ($msg -match "result:|sendTranscript|sidebar:|ackLong") {
            Write-Log "CMD" $msg $C_CMD
          } elseif ($msg -match "TTS|speak|WebSpeech") {
            Write-Log "TTS" $msg "DarkYellow"
          } elseif ($msg -match "wake|__NEXUS") {
            Write-Log "WAKE" $msg $C_FRONT
          } elseif ($msg -match "didn't catch|retry") {
            Write-Log "RETRY" $msg $C_CMD
          } else {
            Write-Log "UI" $msg $C_FRONT
          }
        }
      }
    }

    # NEXUS stderr (errors)
    $errLines = Get-NewLines $nexusErr ([ref]$pos.Err)
    foreach ($line in $errLines) {
      $clean = $line -replace '\x1b\[[0-9;]*m', ""
      if ($clean -match "sending transcript|worker response") {
        Write-Log "NET" $clean $C_CMD
      } elseif ($clean.Length -gt 5 -and $clean -notmatch "registry key|Chrome_WidgetWin") {
        Write-Log "ERR" $clean $C_ERR
      }
    }
  }
} finally {
  Write-Log "EXIT" "NEXUS process exited." $C_ERR
  Stop-All
}
