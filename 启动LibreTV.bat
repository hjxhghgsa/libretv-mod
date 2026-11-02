@echo off
title LibreTV
cd /d "%~dp0"
node "%~dp0libretv-server.js" start
if errorlevel 1 pause
