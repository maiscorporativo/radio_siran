@echo off
chcp 65001 >nul
title Rádio Siran - servidor local
REM Modo 100% local: o próprio notebook roda o servidor (painel + player).
REM Painel: http://localhost:3000   |   Player: link da unidade (localhost)
cd /d "%~dp0.."
if not exist node_modules (
  echo Instalando dependências pela primeira vez...
  call npm install --omit=dev
)
if not exist .env copy .env.example .env >nul
echo Servidor iniciando em http://localhost:3000
node server/index.js
pause
