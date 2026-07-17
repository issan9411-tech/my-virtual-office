@echo off
rem Claude Code トークンダッシュボード起動スクリプト (Windows)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
    pause
    exit /b 1
)
start "" http://localhost:4545
node server.js
pause
