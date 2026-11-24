; Inno Setup script for the OrcaAudioCleanup Windows installer.
; Build: ISCC /DAppVersion=0.2.2 packaging\windows\OrcaAudioCleanup.iss  (needs packaging\windows\build\uv.exe)
; The installer copies the app, then Finish-Setup.ps1 downloads the engine and the voice models.

#ifndef AppVersion
  #error Pass the version: ISCC /DAppVersion=x.y.z
#endif
#define Repo "..\.."

[Setup]
AppId={{EDB2F7F4-AFD3-4A58-9F52-39665A96FF52}
AppName=OrcaAudioCleanup
AppVersion={#AppVersion}
AppVerName=OrcaAudioCleanup {#AppVersion}
AppPublisher=Square Circle Labs
AppPublisherURL=https://squarecirclelabs.com/
AppSupportURL=https://github.com/24pfilms/OrcaAudioClean
DefaultDirName={localappdata}\Programs\OrcaAudioCleanup
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#Repo}\dist
OutputBaseFilename=OrcaAudioCleanup-Setup-{#AppVersion}
SetupIconFile={#Repo}\windows_app\OrcaAudioCleanup.ico
UninstallDisplayIcon={app}\windows_app\OrcaAudioCleanup.ico
UninstallDisplayName=OrcaAudioCleanup
WizardStyle=modern
Compression=lzma2
SolidCompression=yes

[Messages]
WelcomeLabel2=This installs OrcaAudioCleanup, which cleans the voice in your videos on this PC.%n%nAfter copying its files, setup downloads the engine and the voice models (about 2 GB, once). That can take 10 to 20 minutes. A window shows the progress.

[Files]
Source: "{#Repo}\src\*"; DestDir: "{app}\src"; Excludes: "__pycache__,*.pyc"; Flags: recursesubdirs ignoreversion
Source: "{#Repo}\windows_app\*"; DestDir: "{app}\windows_app"; Excludes: "__pycache__,*.pyc"; Flags: recursesubdirs ignoreversion
Source: "{#Repo}\pyproject.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\uv.lock"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\.python-version"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\OrcaAudioCleanup.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\OrcaAudioCleanupApp.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\Install-OrcaAudioCleanup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Repo}\Uninstall-OrcaAudioCleanup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "Finish-Setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\uv.exe"; DestDir: "{app}\tools"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\OrcaAudioCleanup"; Filename: "{app}\.venv\Scripts\pythonw.exe"; Parameters: """{app}\windows_app\main.py"""; WorkingDir: "{app}"; IconFilename: "{app}\windows_app\OrcaAudioCleanup.ico"
Name: "{autoprograms}\Finish OrcaAudioCleanup setup"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Finish-Setup.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\windows_app\OrcaAudioCleanup.ico"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Finish-Setup.ps1"""; StatusMsg: "Downloading the engine and voice models (about 2 GB). Watch the other window for progress..."; Check: not WizardSilent; Flags: waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Finish-Setup.ps1"" -Quiet"; Check: WizardSilent; Flags: waituntilterminated runhidden
Filename: "{app}\.venv\Scripts\pythonw.exe"; Parameters: """{app}\windows_app\main.py"""; WorkingDir: "{app}"; Description: "Open OrcaAudioCleanup now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Uninstall-OrcaAudioCleanup.ps1"""; Flags: runhidden; RunOnceId: "RemoveMenus"

[UninstallDelete]
; What setup downloaded: the engine, Python, the models and the window's list. Never the user's videos.
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\windows_app"
Type: filesandordirs; Name: "{localappdata}\OrcaAudioCleanup"
Type: files; Name: "{%USERPROFILE}\.cache\booth\bin\ffmpeg.exe"
Type: files; Name: "{%USERPROFILE}\.cache\booth\bin\ffprobe.exe"
Type: dirifempty; Name: "{app}"
