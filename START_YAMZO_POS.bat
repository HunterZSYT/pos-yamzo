@echo off
setlocal

cd /d "%~dp0"

set "APP_EXE=release-packaged\win-unpacked\Yamzo POS.exe"

if exist "%APP_EXE%" (
  start "" "%APP_EXE%"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required to build Yamzo POS on this computer.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js LTS with npm enabled.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing Yamzo POS dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Building packaged Yamzo POS...
call npm run package
if errorlevel 1 (
  echo Yamzo POS packaging failed.
  pause
  exit /b 1
)

if exist "%APP_EXE%" (
  start "" "%APP_EXE%"
  exit /b 0
)

echo Packaged app was not created at "%APP_EXE%".
pause
exit /b 1
