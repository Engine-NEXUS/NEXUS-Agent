# scripts/build.ps1 — cross-platform build helper (run on each OS).
# Usage:
#   pwsh ./scripts/build.ps1              # build frontend + tauri (release)
#   pwsh ./scripts/build.ps1 -Target aarch64-apple-darwin
#   pwsh ./scripts/build.ps1 -Bundles "nsis,msi"

param(
  [string]$Target = "",
  [string]$Bundles = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Ensure LIBCLANG_PATH is set (needed for bindgen-based crates on Windows).
if (-not $env:LIBCLANG_PATH) {
  $llvmPath = "C:\Program Files\LLVM\bin"
  if (Test-Path "$llvmPath\libclang.dll") {
    $env:LIBCLANG_PATH = $llvmPath
    Write-Host "==> Set LIBCLANG_PATH=$llvmPath" -ForegroundColor DarkGray
  }
}

Write-Host "==> Installing frontend deps" -ForegroundColor Cyan
npm --prefix frontend install

Write-Host "==> Building frontend" -ForegroundColor Cyan
npm --prefix frontend run build

Write-Host "==> Building Tauri app" -ForegroundColor Cyan
# `cargo tauri build` is ALWAYS a release build.
# Optional flags: --target <triple> and --bundles <b1,b2>.
$cargoArgs = @("tauri", "build")
if ($Target)  { $cargoArgs += "--target"; $cargoArgs += $Target }
if ($Bundles) { $cargoArgs += "--bundles"; $cargoArgs += $Bundles }

Push-Location src-tauri
  # Ensure the Tauri CLI is available (cargo-installed or via npm).
  if (-not (Get-Command "cargo-tauri" -ErrorAction SilentlyContinue) -and
      -not (npm --prefix ../frontend exec tauri --version 2>$null)) {
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
