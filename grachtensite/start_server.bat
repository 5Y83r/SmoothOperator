@echo off
echo Starting local server for Grachtenplanner...
echo.
echo This will start a local web server to avoid CORS issues.
echo Open your browser and go to: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server when you're done.
echo.
python server_api.py
pause 