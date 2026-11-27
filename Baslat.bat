@echo off
title STLOgi
cd /d "%~dp0"
if not exist node_modules (
  echo Ilk kurulum yapiliyor, biraz surebilir...
  call npm install
)
echo Uygulama hazirlaniyor...
call npm run build >nul
echo STLOgi tarayicida aciliyor. Kapatmak icin bu pencereyi kapatin.
call npx vite preview --open --port 4173 --strictPort
