@echo off
rem Duplo clique (uma vez, com internet): monta o Python proprio na pasta python_portatil.
rem Depois a pasta inteira roda em qualquer Windows 10/11 sem instalar nada.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" -SoPreparar %*
echo.
pause
