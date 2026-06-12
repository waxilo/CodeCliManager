@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

for /f "delims=" %%i in ('powershell -command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"') do set "DATETIME=%%i"

git add .
git commit -m "!DATETIME!"
git push

pause