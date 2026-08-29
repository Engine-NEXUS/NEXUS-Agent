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
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*stt_server*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# ─── Start STT Server ──────────────────────────────────────────────────────
Write-Log "INIT" "Starting STT server (127.0.0.1:39217)..." $C_STT
$sttLog = "$LogDir\stt_unified.log"
$sttErr = "$LogDir\stt_unified_err.log"
$sttProc = Start-Process -FilePath "python" `
  -ArgumentList "stt_server.py" `
  -WorkingDirectory "$ProjectRoot\server" `
  -RedirectStandardOutput $sttLog `
  -RedirectStandardError $sttErr `
  -PassThru -WindowStyle Hidden

$jobs.Add([PSCustomObject]@{ Name="STT"; Process=$sttProc }) | Out-Null

# Wait for STT to be ready
$sttReady = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  try {
    $health = Invoke-RestMethod http://127.0.0.1:39217/health -TimeoutSec 2
    if ($health.ok) {
      Write-Log "STT" "Server ready: model=$($health.model) device=$($health.device)" $C_STT
      $sttReady = $true
      break
    }
  } catch {}
}
if (-not $sttReady) {
  Write-Log "STT" "FAILED to start — check $sttErr" $C_ERR
  Get-Content $sttErr | ForEach-Object { Write-Log "STT" $_ $C_ERR }
  Stop-All
  exit 1
}

# ─── Start NEXUS ───────────────────────────────────────────────────────────
Write-Log "INIT" "Starting NEXUS desktop app..." $C_RUST
$nexusLog = "$LogDir\nexus_unified.log"
$nexusErr = "$LogDir\nexus_unified_err.log"

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
  $lines = @()
  try {
    $fs = [System.IO.File]::Open($File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $fs.Seek($Position.Value, [System.IO.SeekOrigin]::Begin) | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    while ($sr.Peek() -ge 0) {
      $line = $sr.ReadLine()
      $lines += $line
    }
    $Position.Value = $fs.Position
    $sr.Close()
    $fs.Close()
  } catch {}
  return $lines
}

# Main tail loop
try {
  while (-not $nexusProc.HasExited) {
    Start-Sleep -Milliseconds 300

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

    # Rust logs (wake word, audio, baton pass)
    $rustLines = Get-NewLines $nexusLog ([ref]$pos.Rust)
    foreach ($line in $rustLines) {
      # Strip ANSI color codes
      $clean = $line -replace '\x1b\[[0-9;]*m', ""
      # Extract timestamp and level
      if ($clean -match "(\d{2}:\d{2}:\d{2}\.\d+).*?(INFO|DEBUG|WARN|ERROR)\s+(.+)") {
        $level = $Matches[2]
        $msg = $Matches[3]
        $color = switch ($level) {
          "INFO"  { $C_RUST }
          "DEBUG" { "DarkGreen" }
          "WARN"  { "Yellow" }
          "ERROR" { $C_ERR }
          default { "White" }
        }
        # Highlight key events
        if ($msg -match "NEXUS detected|wake.*trigger") {
          Write-Log "WAKE" $msg $C_CMD
        } elseif ($msg -match "stream paused|stream resumed|baton") {
          Write-Log "BATON" $msg $C_CMD
        } elseif ($msg -match "audio passed gate|AGC gain|model probability") {
          # Only show high-probability detections
          if ($msg -match "probability=0\.[3-9]|probability=1\.") {
            Write-Log "WAKE" $msg "DarkYellow"
          }
        } elseif ($msg -match "stream started|device|sample_rate") {
          Write-Log "AUDIO" $msg $C_RUST
        } elseif ($msg -match "3000 callbacks") {
          Write-Log "AUDIO" $msg "DarkGray"
        } else {
          # Skip noisy DEBUG audio gate logs
          if ($level -ne "DEBUG" -or $msg -notmatch "audio passed gate|AGC gain") {
            Write-Log "RUST" $msg $color
          }
        }
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
