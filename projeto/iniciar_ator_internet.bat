@echo off
rem Duplo clique: modo ator com LINK PUBLICO (colegas de qualquer computador/rede).
rem Precisa do cloudflared (uma vez): winget install Cloudflare.cloudflared
rem Passo a passo: MANUAL_TESTE_ONLINE.txt
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" -Ator -Internet %*
echo.
pause
