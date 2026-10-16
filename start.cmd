@echo off
rem Starts VoiceRecon: double-click this file. On first use it installs what is needed
rem (dependencies, about 3 GB of speech models). See README.md, "Setup".
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo VoiceRecon needs Node.js 22.13 or newer. Get it from https://nodejs.org/
  pause
  exit /b 1
)
node scripts\launch.js %*
if errorlevel 1 pause
