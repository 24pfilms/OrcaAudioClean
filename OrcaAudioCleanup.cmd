@echo off
setlocal
rem OrcaAudioCleanup: cleans the voice in videos (and audio files).
rem Writes "<name>-enhanced" beside each original. The original is never changed.
rem Use: drop files on the desktop icon, right-click a video, or
rem      OrcaAudioCleanup.cmd "C:\path\video.mp4" ["C:\path\other.mov" ...]
title OrcaAudioCleanup
if not defined ORCA_AUDIO_HOME set "ORCA_AUDIO_HOME=%LOCALAPPDATA%\OrcaAudioCleanup"
set "HF_HOME=%ORCA_AUDIO_HOME%\hf"
set "TORCH_HOME=%ORCA_AUDIO_HOME%\torch"
set "ENGINE=%~dp0.venv\Scripts\booth.exe"
set "LOCK=%TEMP%\OrcaAudioCleanup.lock"

if "%~1"=="" (
  echo OrcaAudioCleanup
  echo Drop one or more videos on this icon, or right-click a video and choose
  echo "Clean up audio with OrcaAudioCleanup".
  echo.
  pause
  exit /b 0
)

rem One clean-up at a time: if another is running, wait in line.
:wait
2>nul (
  9>"%LOCK%" (
    call :run %*
  )
) || (
  if not defined WAITING (
    echo Another clean-up is running. This one will start when it finishes...
    set WAITING=1
  )
  "%SystemRoot%\System32\timeout.exe" /t 5 /nobreak >nul
  goto wait
)
exit /b %RESULT%

:run
rem 2>&1: the lock above hides errors, so send the engine's messages to the screen.
"%ENGINE%" %* 2>&1
set RESULT=%ERRORLEVEL%
echo.
if %RESULT%==0 (
  echo Done. The cleaned files are next to the originals, named "...-enhanced".
  "%SystemRoot%\System32\timeout.exe" /t 15
) else (
  echo Something went wrong ^(code %RESULT%^). Read the message above.
  pause
)
exit /b 0
