@echo off
setlocal
cd /d "%~dp0"
set "AGENT_SPACE_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "AGENT_SPACE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if "%AGENT_SPACE_NODE%"=="node" goto launch
if not exist "%AGENT_SPACE_NODE%" (
  echo Node.js 22 or later is required. Install Node or use the Codex terminal to start this app.
  pause
  exit /b 1
)
:launch
"%AGENT_SPACE_NODE%" scripts/launch.mjs
