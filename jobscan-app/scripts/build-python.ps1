$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir     = Resolve-Path "$ScriptDir\.."
$RepoRoot   = Resolve-Path "$AppDir\.."
$JobscanSrc = "$RepoRoot\jobscan"

$PlatformTag = "win-x64"
$PbsTriple   = "x86_64-pc-windows-msvc"
$PythonOut   = "$AppDir\resources\python\$PlatformTag"
New-Item -ItemType Directory -Force -Path $PythonOut | Out-Null

# python-build-standalone — check https://github.com/indygreg/python-build-standalone/releases
$PbsVersion = "20241016"
$PbsPyver   = "3.12.7"
$PbsFile    = "cpython-${PbsPyver}+${PbsVersion}-${PbsTriple}-shared-install_only.tar.gz"
$PbsUrl     = "https://github.com/indygreg/python-build-standalone/releases/download/$PbsVersion/$PbsFile"

$TmpDir = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath() + [System.Guid]::NewGuid())
try {
    Write-Host "Downloading python-build-standalone $PbsPyver for $PlatformTag..."
    Invoke-WebRequest -Uri $PbsUrl -OutFile "$TmpDir\$PbsFile"

    Write-Host "Extracting via Python tarfile (avoids Git tar path issues)..."
    $TmpStr = $TmpDir.FullName
    python -c "import tarfile; t=tarfile.open(r'$TmpStr\$PbsFile','r:gz'); t.extractall(r'$TmpStr'); t.close(); print('extracted')"
    if (-not (Test-Path "$TmpStr\python")) { throw "Extraction failed — python dir not found" }
    Copy-Item -Recurse -Force "$TmpStr\python\*" "$PythonOut\"
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

$PythonExe = "$PythonOut\python.exe"
Write-Host "Python: $(& $PythonExe --version)"

Write-Host "Installing Python packages..."
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
& $PythonExe -m pip install --upgrade pip --quiet
& $PythonExe -m pip install `
    playwright `
    "undetected-playwright>=0.3.0" `
    PyPDF2 `
    requests `
    "beautifulsoup4>=4.12.0" `
    "lxml>=4.9.0" `
    geocoder `
    --quiet
Remove-Item Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
Write-Host "  v packages installed"

Write-Host "Copying job_application_automator source..."
New-Item -ItemType Directory -Force -Path "$AppDir\resources\python-src" | Out-Null
Copy-Item -Recurse -Force "$JobscanSrc\job_application_automator" "$AppDir\resources\python-src\"
Get-ChildItem "$JobscanSrc\*.py" -ErrorAction SilentlyContinue |
    Copy-Item -Destination "$AppDir\resources\python-src\" -Force
Write-Host "  v source copied"

Write-Host "Done. resources\python\$PlatformTag\ ready."
