@echo off
REM Windows Setup Script for LargeFileBuster Native Addon
REM This script helps download and set up SQLite3 for Windows builds

echo.
echo ========================================
echo LargeFileBuster - SQLite3 Setup
echo ========================================
echo.

REM Check if PowerShell is available
where powershell >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: PowerShell not found. Please install PowerShell.
    exit /b 1
)

echo Checking for SQLite3 files...
if exist "native\deps\sqlite3.h" if exist "native\deps\sqlite3.c" (
    echo [OK] SQLite3 files already present.
    echo   - sqlite3.h found
    echo   - sqlite3.c found
    echo.
    echo You can now run: npm run build
    exit /b 0
)

echo.
echo SQLite3 files not found in native\deps\
echo.
echo Would you like to download SQLite3 amalgamation? (Y/N)
set /p DOWNLOAD="Enter choice: "

if /i "%DOWNLOAD%" NEQ "Y" (
    echo.
    echo Setup cancelled. Please manually download SQLite3:
    echo   1. Visit https://www.sqlite.org/download.html
    echo   2. Download sqlite-amalgamation-XXXXXXX.zip
    echo   3. Extract sqlite3.h and sqlite3.c to native\deps\
    echo.
    exit /b 0
)

echo.
echo Downloading SQLite3 amalgamation...
echo.

REM Create deps directory if it doesn't exist
if not exist "native\deps" mkdir "native\deps"

REM Download SQLite amalgamation using PowerShell
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.sqlite.org/2024/sqlite-amalgamation-3450100.zip' -OutFile 'native\deps\sqlite-temp.zip'}"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Download failed. Please check your internet connection.
    echo.
    echo Manual download instructions:
    echo   1. Visit https://www.sqlite.org/download.html
    echo   2. Download sqlite-amalgamation-XXXXXXX.zip
    echo   3. Extract to native\deps\
    echo.
    exit /b 1
)

echo.
echo Extracting files...
powershell -Command "& {Expand-Archive -Path 'native\deps\sqlite-temp.zip' -DestinationPath 'native\deps\sqlite-temp' -Force}"

REM Find and copy the files
echo Looking for sqlite3.h and sqlite3.c...
for /d %%d in (native\deps\sqlite-temp\sqlite-*) do (
    if exist "%%d\sqlite3.h" (
        copy "%%d\sqlite3.h" "native\deps\" >nul
        echo   - Copied sqlite3.h
    )
    if exist "%%d\sqlite3.c" (
        copy "%%d\sqlite3.c" "native\deps\" >nul
        echo   - Copied sqlite3.c
    )
)

REM Cleanup
rd /s /q "native\deps\sqlite-temp" 2>nul
del "native\deps\sqlite-temp.zip" 2>nul

echo.
if exist "native\deps\sqlite3.h" if exist "native\deps\sqlite3.c" (
    echo [SUCCESS] SQLite3 files installed successfully!
    echo.
    echo You can now run: npm run build
    echo.
    echo To use the high-performance native addon:
    echo   set USE_NATIVE=true
    echo   npm start
) else (
    echo [ERROR] Failed to extract files. Please download manually:
    echo   1. Visit https://www.sqlite.org/download.html
    echo   2. Download sqlite-amalgamation-XXXXXXX.zip
    echo   3. Extract sqlite3.h and sqlite3.c to native\deps\
)

echo.
pause
