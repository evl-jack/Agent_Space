@echo off
setlocal
cd /d "%~dp0"
if not exist "scripts\launch.mjs" (
  echo Please extract the entire ZIP before opening Start.cmd.
  echo The scripts folder must be next to this file.
  goto failed
)
set "AGENT_SPACE_NODE=node"
where node >nul 2>nul
if errorlevel 1 goto bundled
node -e "process.exit(Number(process.versions.node.split('.')[0])<22?1:0)" >nul 2>nul
if not errorlevel 1 goto launch
:bundled
set "AGENT_SPACE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%AGENT_SPACE_NODE%" goto missing_node
"%AGENT_SPACE_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0])<22?1:0)" >nul 2>nul
if errorlevel 1 goto missing_node
:launch
"%AGENT_SPACE_NODE%" scripts/launch.mjs
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Node.js 22 or later is required. Install Node or use the Codex terminal to start this app.
:failed
echo.
echo Agent Space could not start. Please keep the error above for troubleshooting.
pause
exit /b 1
