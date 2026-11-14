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

Write-Host "Done."
