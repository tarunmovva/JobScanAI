$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location ..
Write-Host "=== JobScan AI — Full Build (Windows) ==="
Write-Host "`nStep 1/4: Cross-compile Go CLI + copy Codex binaries..."
& .\scripts\build-go.ps1
Write-Host "`nStep 2/4: Bundle Python..."
& .\scripts\build-python.ps1
Write-Host "`nStep 3/4: Compile Electron app..."
npm run build
Write-Host "`nStep 4/4: Package Windows installer..."
npm run dist:win
Write-Host "`n=== Done — dist-package\ ==="
