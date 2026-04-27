@echo off
echo Starting ngrok tunnel for Smart Classroom Admin Panel...
echo.
echo Make sure ngrok is installed and authenticated.
echo Download from: https://ngrok.com/download
echo.
echo After authentication, run: ngrok authtoken YOUR_TOKEN
echo.
echo Press any key to start tunneling...
pause > nul

ngrok http 8000

echo.
echo Tunnel closed. Press any key to exit...
pause > nul