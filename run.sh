#!/bin/bash
# Obsidian API Sync - Linux/macOS Startup Script
set -e

# Navigate to the server directory relative to this script
cd "$(dirname "$0")/server"

# Check for .env file
if [ ! -f ".env" ]; then
    echo "[WARNING] .env file not found! Copying .env.example to .env..."
    cp .env.example .env
    echo "Please edit the .env file to set up your configuration (like ADMIN_PASSWORD) and restart."
fi

# Ensure virtual environment exists
if [ ! -d ".venv" ]; then
    echo "[INFO] Virtual environment not found. Setting it up..."
    if command -v uv &> /dev/null; then
        uv venv .venv --python 3.12
    else
        echo "[INFO] uv not found, falling back to standard python3..."
        python3 -m venv .venv
    fi
fi

# Activate environment
source .venv/bin/activate

# Install/Update dependencies automatically if requirements.txt is newer than the environment
if [ requirements.txt -nt .venv ]; then
    echo "[INFO] Updating dependencies..."
    if command -v uv &> /dev/null; then
        uv pip install -r requirements.txt
    else
        pip install -r requirements.txt
    fi
    touch .venv
fi

echo "[INFO] Starting Obsidian API Sync server..."
exec uvicorn main:app --host 0.0.0.0 --port 8000
