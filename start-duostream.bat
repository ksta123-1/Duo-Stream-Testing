@echo off
title DuoStream Bridge Launcher
echo Starting Node.js Signaling Server in background...
start "DuoStream Server" /min cmd /c "cd /d %~dp0server && node index.js"
timeout /t 2 /nobreak >nul
echo Starting Cloudflare Tunnel...
echo Copy the https://xxxx.trycloudflare.com link below and paste it into OmeTV!
cloudflared tunnel --url http://localhost:3000
