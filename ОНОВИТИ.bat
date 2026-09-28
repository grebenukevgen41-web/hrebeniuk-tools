@echo off
chcp 65001 >nul
title Hrebeniuk Tools - update
set "HRB_SITE=https://grebenukevgen41-web.github.io/hrebeniuk-tools/"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $d=Join-Path $env:TEMP 'hrebeniuk'; New-Item -ItemType Directory -Force $d | Out-Null;" ^
  "foreach($f in 'hrb_install.ps1','hrb_setup.py'){ Invoke-WebRequest ($env:HRB_SITE+$f) -OutFile (Join-Path $d $f) -UseBasicParsing };" ^
  "& (Join-Path $d 'hrb_install.ps1') -Mode update -Repo $env:HRB_SITE"
echo.
pause
