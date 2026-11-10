@echo off
chcp 65001 >nul
title Chat Server - port 8000
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo  Starting LAN chat server on port 8000 ...
echo  Local  : http://localhost:8000
echo  Close this window (or press Ctrl+C) to stop the server.
echo.

"%NODE_EXE%" server.js

echo.
echo  Server stopped. Press any key to close.
pause >nul
