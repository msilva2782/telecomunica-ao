@echo off
rem Duplo clique: liga servidor + robo na rede local.
rem Para link pela internet:  iniciar.bat -Internet
rem Sem webcam (video de teste):  iniciar.bat -Sintetica
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" %*
echo.
pause
