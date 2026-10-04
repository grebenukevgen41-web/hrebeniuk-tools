@echo off
chcp 65001 >nul
title PS Tools - встановлення
rem Один файл: бере останню версію PS Tools із сайту і встановлює (панель, скрипти, Batch Export).
echo Завантажую PS Tools з сайту...
set "PST_ZIP=https://grebenukevgen41-web.github.io/hrebeniuk-tools/ps/PS_Tools.zip"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
  "$d=Join-Path $env:TEMP 'PS_Tools_setup'; if(Test-Path $d){Remove-Item $d -Recurse -Force}; New-Item -ItemType Directory $d | Out-Null;" ^
  "$z=Join-Path $d 'PS_Tools.zip'; Invoke-WebRequest $env:PST_ZIP -OutFile $z -UseBasicParsing; Expand-Archive $z $d -Force;" ^
  "$i=Get-ChildItem $d -Recurse -Filter install.ps1 | Select-Object -First 1; & powershell -NoProfile -ExecutionPolicy Bypass -File $i.FullName; exit $LASTEXITCODE"
if errorlevel 1 echo. & echo Щось пішло не так. Перевір інтернет і запусти ще раз. Лог: %TEMP%\PSTools_install.log
echo.
pause
