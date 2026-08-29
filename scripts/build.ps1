# scripts/build.ps1 — cross-platform build helper (run on each OS).
# Usage:
#   pwsh ./scripts/build.ps1              # debug build of frontend + rust (tauri build = release)
#   pwsh ./scripts/build.ps1 -Release      # produce signed installers (same as default; kept for compat)
#   pwsh ./scripts/build.ps1 -Target aarch64-apple-darwin

param(
  [switch]$Release,
  [string]$Target = "",
  [string]$Bundles = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Installing frontend deps" -ForegroundColor Cyan
pnpm --dir frontend install --frozen-lockfile

Write-Host "==> Building frontend" -ForegroundColor Cyan
pnpm --dir frontend run build

Write-Host "==> Building Tauri app" -ForegroundColor Cyan
# `cargo tauri build` is ALWAYS a release build — there is no `--release` flag for it.
# Optional flags: --target <triple> and --bundles <b1,b2>.
$cargoArgs = @("tauri", "build")
if ($Target)  { $cargoArgs += "--target"; $cargoArgs += $Target }
if ($Bundles) { $cargoArgs += "--bundles"; $cargoArgs += $Bundles }

Push-Location src-tauri
  # Ensure the Tauri CLI is available (cargo-installed or via pnpm).
  if (-not (Get-Command "cargo-tauri" -ErrorAction SilentlyContinue) -and
      -not (pnpm --dir frontend exec tauri --version 2>$null)) {
    Write-Host "==> Installing tauri-cli" -ForegroundColor Yellow
    cargo install tauri-cli --version "^2" --locked
  }
  cargo @cargoArgs
Pop-Location

Write-Host "==> Artifacts:" -ForegroundColor Green
if ($IsWindows -or $env:OS -eq "Windows_NT") {
  Get-ChildItem -Recurse src-tauri\target\release\bundle -Include *.exe,*.msi -ErrorAction SilentlyContinue | Select-Object FullName
} elseif ($IsMacOS) {
  Get-ChildItem -Recurse src-tauri/target/release/bundle -Include *.dmg,*.app -ErrorAction SilentlyContinue | Select-Object FullName
} else {
  Get-ChildItem -Recurse src-tauri/target/release/bundle -Include *.AppImage,*.deb -ErrorAction SilentlyContinue | Select-Object FullName
}

# --- Signing (Windows NSIS) ---
# Set these env vars in CI secrets to enable authenticode signing:
#   TAURI_SIGNING_PRIVATE_KEY (base64 of EV cert pfx)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# Tauri's NSIS bundler auto-signs when TAURI_SIGNING_PRIVATE_KEY is present.

# --- macOS notarization ---
# export APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID, APPLE_CERTIFICATE (p12 base64),
# APPLE_CERTIFICATE_PASSWORD in CI; `tauri build` invokes notarytool automatically.
