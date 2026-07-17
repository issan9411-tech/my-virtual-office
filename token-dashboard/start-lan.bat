@echo off
rem スマホ(同じWi-Fi内)からも見られるモードで起動するスクリプト (Windows)
rem 起動後にコンソールへ表示される http://192.168.x.x:4545?token=... をスマホで開いてください。
rem 初回起動時に Windows ファイアウォールの許可ダイアログが出たら「アクセスを許可」を選択。
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
    pause
    exit /b 1
)
set HOST=0.0.0.0
if "%DASH_TOKEN%"=="" set DASH_TOKEN=%RANDOM%%RANDOM%%RANDOM%
node server.js
pause
