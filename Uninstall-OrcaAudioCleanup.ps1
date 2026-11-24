# Removes what Install-OrcaAudioCleanup.ps1 added. Leaves the app folder and the models in %LOCALAPPDATA%\OrcaAudioCleanup (or ORCA_AUDIO_HOME).
$types = ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mts", ".wav", ".mp3", ".m4a", ".flac", ".aac"
foreach ($t in $types) {
    foreach ($name in "OrcaAudioCleanup", "OrcaAudioCleanupOpen", "OrcaCleanup") {
        Remove-Item -Path "HKCU:\Software\Classes\SystemFileAssociations\$t\shell\$name" -Recurse -Force -ErrorAction SilentlyContinue
    }
}
foreach ($name in "OrcaAudioCleanup.lnk", "Orca Cleanup.lnk") {
    Remove-Item (Join-Path ([Environment]::GetFolderPath("SendTo")) $name) -ErrorAction SilentlyContinue
    Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) $name) -ErrorAction SilentlyContinue
}
Write-Host "OrcaAudioCleanup removed from the desktop, the right-click menu and Send to."
