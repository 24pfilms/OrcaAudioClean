# Finishes installing OrcaAudioCleanup once the installer has copied its files:
#   1. the engine (Python and its packages, about 1 GB) into this folder, with the bundled uv
#   2. ffmpeg, if this PC has none (a pinned, checksum-verified Windows build)
#   3. the voice models (about 1.1 GB) into %LOCALAPPDATA%\OrcaAudioCleanup (or ORCA_AUDIO_HOME)
#   4. the desktop icon, right-click menu and Send to (Install-OrcaAudioCleanup.ps1)
# Safe to run again: each step skips what is already there. -Quiet: no prompts, output to setup.log.
param([switch]$Quiet)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$uv = Join-Path $root "tools\uv.exe"
$booth = Join-Path $root ".venv\Scripts\booth.exe"
$data = if ($env:ORCA_AUDIO_HOME) { $env:ORCA_AUDIO_HOME } else { Join-Path $env:LOCALAPPDATA "OrcaAudioCleanup" }
$log = Join-Path $data "setup.log"
# The engine looks here for ffmpeg when none is installed (booth.tools.BIN_DIR).
$bin = Join-Path $env:USERPROFILE ".cache\booth\bin"
$ffmpegZip = "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip"
$ffmpegSha256 = "b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd"

$env:UV_PYTHON_INSTALL_DIR = Join-Path $root "python"
$env:UV_PYTHON_PREFERENCE = "only-managed"
$env:UV_CACHE_DIR = Join-Path $data "uv-cache"
$env:HF_HOME = Join-Path $data "hf"
$env:TORCH_HOME = Join-Path $data "torch"
$env:PYTHONIOENCODING = "utf-8"

function Step([string]$text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan
    if ($Quiet) { Add-Content -Path $log -Value "== $text" }
}

# Runs a program. Interactive: live progress on screen. Quiet: output goes to setup.log.
function Invoke-Tool([string]$exe, [string[]]$arguments, [string]$what) {
    if ($Quiet) {
        $old = $ErrorActionPreference
        $ErrorActionPreference = "Continue"     # stderr lines are progress, not failures
        try { & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $log }
        finally { $ErrorActionPreference = $old }
    } else {
        & $exe @arguments
    }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (code $LASTEXITCODE)." }
}

New-Item -ItemType Directory -Force -Path $data | Out-Null
if ($Quiet) { Set-Content -Path $log -Value "OrcaAudioCleanup setup $(Get-Date -Format s)" }

try {
    Write-Host "Setting up OrcaAudioCleanup. This downloads about 2 GB once and can take 10 to 20 minutes." -ForegroundColor White
    Write-Host "Leave this window open. It closes by itself when everything is ready."

    Step "Step 1 of 4: the engine (Python and its parts)"
    Push-Location $root
    try { Invoke-Tool $uv @("sync", "--frozen", "--python", "3.11", "--extra", "ui", "--no-dev") "Installing the engine" }
    finally { Pop-Location }
    # The packages are now in .venv; the download cache would only take up space.
    Remove-Item -Recurse -Force -Path $env:UV_CACHE_DIR -ErrorAction SilentlyContinue

    Step "Step 2 of 4: ffmpeg (reads and writes the videos)"
    $haveOwn = (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)
    $haveOurs = (Test-Path (Join-Path $bin "ffmpeg.exe")) -and (Test-Path (Join-Path $bin "ffprobe.exe"))
    if ($haveOwn -or $haveOurs) {
        Write-Host "Already there."
    } else {
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        $zip = Join-Path $env:TEMP "orca-ffmpeg-9.1.zip"
        Invoke-Tool "curl.exe" @("-L", "--fail", "--retry", "3", "-o", $zip, $ffmpegZip) "Downloading ffmpeg"
        $hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
        if ($hash -ne $ffmpegSha256) {
            Remove-Item -Force $zip
            throw "The ffmpeg download didn't match its checksum, so it was not used."
        }
        Invoke-Tool "tar.exe" @("-xf", $zip, "-C", $bin, "--strip-components", "2",
            "ffmpeg-9.1-essentials_build/bin/ffmpeg.exe", "ffmpeg-9.1-essentials_build/bin/ffprobe.exe") "Unpacking ffmpeg"
        Remove-Item -Force $zip
    }

    Step "Step 3 of 4: the voice models (about 1.1 GB)"
    Invoke-Tool $booth @("setup") "Downloading the voice models"

    Step "Step 4 of 4: desktop icon and right-click menu"
    & (Join-Path $root "Install-OrcaAudioCleanup.ps1")

    Write-Host ""
    Write-Host "All done. Open OrcaAudioCleanup from the desktop icon or the Start menu." -ForegroundColor Green
    if ($Quiet) { Add-Content -Path $log -Value "== Done" }
    else { Start-Sleep -Seconds 8 }
    exit 0
} catch {
    Write-Host ""
    Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Check your internet connection, then open the Start menu and run"
    Write-Host "'Finish OrcaAudioCleanup setup' to try again. It picks up where it stopped."
    if ($Quiet) { Add-Content -Path $log -Value "== Failed: $($_.Exception.Message)" }
    else { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}
