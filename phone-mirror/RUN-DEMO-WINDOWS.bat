@echo off
cd /d "%~dp0desktop-test"
where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.10+ from python.org
  pause
  exit /b 1
)
echo Preparing Banyan MJPEG demo (first run may install Pillow)...
py -m pip install -r requirements.txt
if errorlevel 1 ( pause & exit /b 1 )
echo.
echo Open http://YOUR_PC_IP:8765 in Banyan, PIN 684293
py server.py
pause
