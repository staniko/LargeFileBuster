/*
 * SQLite3 Extension Stub for Windows Builds
 *
 * This file is used when sqlite3.c is not available.
 * To use the native SQLite implementation on Windows, please:
 *
 * 1. Download sqlite-amalgamation from https://www.sqlite.org/download.html
 * 2. Extract sqlite3.c and sqlite3.h to the native/deps/ directory
 * 3. Rebuild the project
 *
 * Without sqlite3.c, the build will fail and you should use the JavaScript
 * implementation by running the app without USE_NATIVE=true
 */

#ifdef _WIN32
#ifndef SQLITE3_C_AVAILABLE
#error "SQLite3 amalgamation not found. Please see native/deps/README.md for instructions."
#endif
#endif
