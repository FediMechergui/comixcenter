@echo off
rem Starts ComixCenter so this PC and phones on the same Wi-Fi can use it.
cd /d "%~dp0backend"
python -m comix serve --lan %*
