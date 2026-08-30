@echo off
REM NEXUS CLI — simple command to start NEXUS from any terminal
REM
REM Usage:
REM   nexus start       — start NEXUS with unified console
REM   nexus stop        — stop NEXUS and STT server
REM   nexus status      — check if NEXUS is running
REM   nexus logs        — tail NEXUS logs
REM   nexus build       — rebuild NEXUS
REM   nexus diagnostics — check all service connections
REM   nexus help        — show this help

setlocal

set PROJECT_ROOT=C:\PROJECTS\ULTRON
set NEXUS_EXE=%PROJECT_ROOT%\src-tauri\target\release\nexus.exe
set LOG_DIR=%APPDATA%\com.nexus.assistant

if "%1"=="" goto :help
if /i "%1"=="start" goto :start
if /i "%1"=="stop" goto :stop
if /i "%1"=="status" goto :status
if /i "%1"=="logs" goto :logs
if /i "%1"=="build" goto :build
if /i "%1"=="diagnostics" goto :diagnostics
if /i "%1"=="diag" goto :diagnostics
goto :help

:start
echo [NEXUS] Starting NEXUS with unified console...
pwsh -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\run.ps1" %2 %3
goto :eof

:stop
echo [NEXUS] Stopping NEXUS...
taskkill /F /IM nexus.exe 2>nul
for /f "tokens=2" %%i in ('tasklist /FI "IMAGENAME eq python.exe" /FO CSV 2^>nul ^| findstr stt_server') do taskkill /F /PID %%i 2>nul
echo [NEXUS] Stopped.
goto :eof

:status
tasklist /FI "IMAGENAME eq nexus.exe" 2>nul | findstr nexus.exe >nul
if %ERRORLEVEL%==0 (
    echo [NEXUS] Running
    for /f "tokens=2 delims=," %%i in ('tasklist /FI "IMAGENAME eq nexus.exe" /FO CSV /NH 2^>nul') do echo [NEXUS] PID: %%~i
) else (
    echo [NEXUS] Not running
)
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:39217/health' -TimeoutSec 3 -UseBasicParsing; Write-Host '[STT]  Connected' } catch { Write-Host '[STT]  Not running' }" 2>nul
goto :eof

:logs
echo [NEXUS] Tailing logs (Ctrl+C to stop)...
if exist "%LOG_DIR%\nexus_unified.log" (
    powershell -NoProfile -Command "Get-Content '%LOG_DIR%\nexus_unified.log' -Tail 50 -Wait"
) else if exist "%LOG_DIR%\nexus_stdout.log" (
    powershell -NoProfile -Command "Get-Content '%LOG_DIR%\nexus_stdout.log' -Tail 50 -Wait"
) else (
    echo [NEXUS] No logs found. Start NEXUS first.
)
goto :eof

:build
echo [NEXUS] Building...
cd /d "%PROJECT_ROOT%"
pwsh -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\build.ps1"
goto :eof

:diagnostics
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\diagnostics.ps1"
goto :eof

:help
echo.
echo   NEXUS CLI - Command Reference
echo.
echo   nexus start       Start NEXUS with unified console (all logs)
echo   nexus start -Build  Rebuild before starting
echo   nexus start -Debug  Enable CDP debugging port 9222
echo   nexus stop        Stop NEXUS and STT server
echo   nexus status      Check if NEXUS is running
echo   nexus logs        Tail NEXUS logs in real-time
echo   nexus build       Rebuild NEXUS (frontend + Rust + installer)
echo   nexus diagnostics Check all service connections (STT, TTS, Worker, GitHub, Google)
echo   nexus help        Show this help
echo.
goto :eof
