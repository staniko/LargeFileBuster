# SQLite3 Dependencies

## For Windows Builds

This directory should contain:
- `sqlite3.h` - SQLite3 header file
- `sqlite3.c` - SQLite3 amalgamation source file

### How to obtain these files:

1. **Download from SQLite.org**:
   Visit https://www.sqlite.org/download.html
   Download "sqlite-amalgamation-XXXXXXX.zip"
   Extract `sqlite3.h` and `sqlite3.c` to this directory

2. **Alternative - Use vcpkg** (Recommended for Windows):
   ```cmd
   vcpkg install sqlite3:x64-windows
   ```

3. **Alternative - Use prebuilt binaries**:
   Download from https://www.sqlite.org/download.html
   Get "sqlite-dll-win64-x64-XXXXXXX.zip"

## For Linux/Mac

The native build will use the system SQLite3 library.
Install with:
- Linux: `apt-get install libsqlite3-dev`
- macOS: `brew install sqlite3`

## Fallback

If the native build fails, the application will automatically use the JavaScript implementation (sql.js).
