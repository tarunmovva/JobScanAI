$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir     = Resolve-Path "$ScriptDir\.."
$RepoRoot   = Resolve-Path "$AppDir\.."
$JobscanSrc = "$RepoRoot\jobscan"
$BinDir     = "$AppDir\resources\bin"
$NM         = "$AppDir\node_modules"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Write-Host "Building jobscan for all platforms..."

Push-Location $JobscanSrc
$env:GOOS = "windows"; $env:GOARCH = "amd64"
go build -ldflags="-s -w" -o "$BinDir\jobscan-win-x64.exe" .
Write-Host "  v jobscan win-x64"

$env:GOOS = "darwin"; $env:GOARCH = "arm64"
go build -ldflags="-s -w" -o "$BinDir\jobscan-mac-arm64" .
Write-Host "  v jobscan mac-arm64"

$env:GOOS = "darwin"; $env:GOARCH = "amd64"
go build -ldflags="-s -w" -o "$BinDir\jobscan-mac-x64" .
Write-Host "  v jobscan mac-x64"
Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
Pop-Location

Write-Host "Copying Codex native binaries..."
# The vendored binary moved from vendor/<triple>/codex/ to vendor/<triple>/bin/
# somewhere between 0.128 and 0.153. Probe both so a pin bump cannot silently
# ship no binary (or leave a stale one behind in resources/bin).
function Copy-Codex($Pkg, $Triple, $Exe, $Dest, $Label) {
  foreach ($Sub in @("bin", "codex")) {
    $Src = "$NM\@openai\$Pkg\vendor\$Triple\$Sub\$Exe"
    if (Test-Path $Src) {
      Copy-Item $Src $Dest -Force
      Write-Host "  v codex $Label (vendor/$Triple/$Sub)"
      return
    }
  }
  Write-Host "  ! codex $Label not found under vendor/$Triple/{bin,codex}"
}

Copy-Codex "codex-win32-x64"    "x86_64-pc-windows-msvc" "codex.exe" "$BinDir\codex-win-x64.exe" "win-x64"
Copy-Codex "codex-darwin-arm64" "aarch64-apple-darwin"   "codex"     "$BinDir\codex-mac-arm64"   "mac-arm64"
Copy-Codex "codex-darwin-x64"   "x86_64-apple-darwin"    "codex"     "$BinDir\codex-mac-x64"     "mac-x64"

Write-Host "Done."
