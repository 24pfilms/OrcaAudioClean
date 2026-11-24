# Adds OrcaAudioCleanup to Windows for this user only (no admin needed):
#   1. Desktop icon "OrcaAudioCleanup": opens the window (drop files in, listen, mix, save).
#      Dropping files on the icon opens the window with them queued.
#   2. Right-click a video or audio file:
#        "Clean up audio with OrcaAudioCleanup"  quick clean, no window
#        "Open in OrcaAudioCleanup"              adds it to the window's queue
#      (Windows 11: under "Show more options")
#   3. Right-click -> Send to -> OrcaAudioCleanup (quick clean, many files at once)
# Undo everything with Uninstall-OrcaAudioCleanup.ps1.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$quick = Join-Path $root "OrcaAudioCleanup.cmd"
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
$main = Join-Path $root "windows_app\main.py"
$icon = Join-Path $root "windows_app\OrcaAudioCleanup.ico"
if (-not (Test-Path $icon)) { $icon = "$env:SystemRoot\System32\imageres.dll,-1026" }

$types = ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mts", ".wav", ".mp3", ".m4a", ".flac", ".aac"
foreach ($t in $types) {
    $base = "HKCU:\Software\Classes\SystemFileAssociations\$t\shell"
    $key = "$base\OrcaAudioCleanup"
    New-Item -Path "$key\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value "Clean up audio with OrcaAudioCleanup"
    Set-ItemProperty -Path $key -Name "Icon" -Value $icon
    Set-ItemProperty -Path "$key\command" -Name "(default)" -Value "`"$quick`" `"%1`""

    $key = "$base\OrcaAudioCleanupOpen"
    New-Item -Path "$key\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value "Open in OrcaAudioCleanup"
    Set-ItemProperty -Path $key -Name "Icon" -Value $icon
    Set-ItemProperty -Path "$key\command" -Name "(default)" -Value "`"$pythonw`" `"$main`" `"%1`""
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("SendTo")) "OrcaAudioCleanup.lnk"))
$lnk.TargetPath = $quick
$lnk.WorkingDirectory = $root
$lnk.IconLocation = $icon
$lnk.Description = "Quick clean-up of the voice in videos and recordings"
$lnk.Save()

$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "OrcaAudioCleanup.lnk"))
$lnk.TargetPath = $pythonw
$lnk.Arguments = "`"$main`""
$lnk.WorkingDirectory = $root
$lnk.IconLocation = $icon
$lnk.Description = "OrcaAudioCleanup: clean the voice in videos, listen before and after, mix"
$lnk.Save()

Write-Host "OrcaAudioCleanup installed: desktop icon (window), right-click menu ($($types.Count) file types), Send to."
