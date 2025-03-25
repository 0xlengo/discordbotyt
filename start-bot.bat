@echo off
cd /d D:\Proyectos\discordbotyt
set DETACHED_PROCESS=1
set NODE_OPTIONS=--no-warnings
set NODE_CHILD_PROCESS_WINDOWS_HIDE=1
C:\Users\Sande\AppData\Roaming\npm\pm2.cmd start index.js --name discord-bot -- --silent
exit 