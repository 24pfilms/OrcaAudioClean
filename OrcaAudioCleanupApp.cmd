@echo off
rem Opens the OrcaAudioCleanup window. Files given here (or dropped on the icon)
rem go into its queue; if the window is already open they are added to it.
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0windows_app\main.py" %*
