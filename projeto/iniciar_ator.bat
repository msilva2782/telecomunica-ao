@echo off
rem Duplo clique: liga o MODO ATOR (uma pessoa faz o papel do robo).
rem Veja GUIA_MODO_ATOR.txt.  Pela internet:  iniciar_ator.bat -Internet
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" -Ator %*
echo.
pause
