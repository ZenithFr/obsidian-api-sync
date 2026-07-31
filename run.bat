@echo off
setlocal
:: Obsidian API Sync - Windows Startup Script

cd /d "%~dp0\server"

:: Check for .env file
if not exist ".env" (
    echo [WARNING] .env file not found! Copying .env.example to .env...
    copy .env.example .env
    echo Please edit the .env file to set up your configuration ^(like ADMIN_PASSWORD^) and restart.
)

:: Ensure virtual environment exists
if not exist ".venv\Scripts\activate.bat" (
    echo [INFO] Virtual environment not found. Setting it up...
    where uv >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        uv venv .venv --python 3.12
    ) else (
        echo [INFO] uv not found, falling back to standard python...
        python -m venv .venv
    )
)

:: Activate environment
call .venv\Scripts\activate.bat

:: Install/Update dependencies
echo [INFO] Ensuring dependencies are installed...
where uv >nul 2>nul
if %ERRORLEVEL% equ 0 (
    uv pip install -r requirements.txt >nul 2>&1
) else (
    pip install -r requirements.txt >nul 2>&1
)

echo [INFO] Starting Obsidian API Sync server...
uvicorn main:app --host 0.0.0.0 --port 8000
