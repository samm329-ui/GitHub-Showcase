@echo off
rem Save My Edits - fallback launcher for machines where .vbs is disabled.
rem Uses PowerShell's hidden Start-Process so no terminal stays open.
cd /d "%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList '--import','tsx','tools\launch-preview.ts' -WorkingDirectory '%CD%'"
